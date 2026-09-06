import { SCENE_LABELS } from '../scenes';
import { activeTeamIds, getTeam } from '../state';
import {
  nextVersusFocus,
  swapTeamPair,
  versusPairOptions,
  versusStatusLabel,
  versusStatusTip,
  versusTileActions,
  versusTileHalf,
} from '../versus-pairs';
import { formatReplayRate } from '../replay-ring';
import { blackoutDurationMs, blackoutRemainingSec, blackoutTarget } from '../blackout';
import { isPureCameraOverlay, liveOverlayAllOff } from '../live-frame';
import { el } from './dom';
import { openModal } from './modal';
import { toast } from './toast';
import type { Ctx } from './ctx';
import type {
  LauncherExtraSceneId,
  PhotoSettings,
  SceneId,
  SceneOpts,
  SceneTransitionMode,
} from '../types';

interface SceneBtn {
  scene: SceneId;
  key?: string;
  tip: string;
  /** 2열 그리드에서 한 줄을 통째로 쓴다 — 바로 아래 붙는 조작이 있는 버튼용 (U73) */
  wide?: true;
  /** 기본으로는 내려 두고 [설정] 탭에서 개별 복원하는 버튼 (U66) */
  optional?: true;
}

/**
 * 운영자가 "이 씬으로 가자"고 고른 것을 액션으로 만든다 — **런처 버튼과 F1~F10 단축키가
 * 함께 쓰는 유일한 빌더**다 (U86).
 *
 * ## 왜 하나여야 하나 — 실제 사고 (U86)
 * 사용자 보고: "팀별 사전미션 상태에서 F1을 누르면 장면 전환 효과가 안 뜸."
 *
 * 런처의 [대기 화면] 버튼은 이 빌더를 써서 `opts: {standby:{mode:'main'}}`을 실어 보냈지만,
 * `control.ts`의 F1은 `{type:'scene/set', scene:'standby'}`를 **맨몸으로** 냈다. 그러면
 * `scene-routing.ts`의 `sceneSetChange()`가 `action.opts?.standby?.mode`를 `undefined`로 읽고
 * "바뀌는 것이 없다"(`null`)고 판정해 전환을 걸지 않는다 — 씬 id는 둘 다 `standby`라
 * 모드만이 유일한 차이인데 그 모드가 액션에 없기 때문이다. 리듀서는 자기 폴백으로 모드를
 * `main`으로 세워 화면은 넘어가지만, 스팅어가 빠진 **하드컷**으로 넘어간다.
 *
 * 같은 뜻의 조작이 두 곳에서 서로 다른 액션을 만들면 이런 어긋남이 조용히 생긴다.
 * 두 경로가 이 함수 하나를 지나면 그 자리가 사라진다(리플레이 버튼과 `R`이 같은
 * `toggleReplay()`를 쓰는 것과 같은 규율이다).
 *
 * 이미 `standby/main`에 서 있을 때 다시 고르면 `sceneSetChange()`가 `null`을 돌려주므로
 * 전환이 걸리지 않는다 — 같은 화면 위로 스팅어가 반복해서 떨어지지 않는다.
 *
 * ## 같은 형태의 두 번째 사고 — 스코어보드 (U89)
 * `score`도 **씬 하나에 두 얼굴**이 있는 자리다: `sceneOpts.score.highlight`가 `null`이면
 * 전 종목을 늘어놓는 전체 보드, 종목 id가 박혀 있으면 그 한 칸만 여는 공개용 보드다
 * (`scenes/score.ts`). 큐시트의 `score-<종목>` 항목이 그 id를 박아 두는데, 종목 공개를 마치고
 * F3(또는 런처 버튼)로 돌아오면 액션에 `score`가 없어 **하이라이트가 그대로 남는다** —
 * 운영자는 전체 보드를 부른 줄 알고 한 칸짜리 공개 화면을 내보낸다. U86과 같은 뿌리다:
 * 씬 id가 같아 액션이 침묵하면 화면은 직전 얼굴을 유지한다.
 *
 * 그래서 F3/버튼은 **언제나 전체 보드**를 뜻하도록 `highlight: null`을 명시한다. 한 종목만
 * 여는 것은 큐시트의 몫이다(대기 화면의 사전미션·선서 모드와 같은 역할 분담).
 *
 * ## 세 번째 얼굴 — 퓨어 카메라 (U131)
 * `live`도 두 얼굴을 얻었다: [퓨어] 버튼이 오버레이를 전부 끈 채로 두면(`pureCameraAction`),
 * [경기 중계 F2]를 다시 눌러도 아무 opts가 없는 예전 그대로라면 크롬이 돌아오지 않는다 —
 * 남의 opts를 건드리지 않는 것이 F2의 오랜 계약이라 오버레이는 손대지 않고 그대로 남기
 * 때문이다. 그래서 **퓨어 상태일 때만** 예외적으로 기본 크롬(스코어바·타이머)을 명시해
 * 복귀시킨다 — 퓨어가 아닌 평소에는 이 분기를 타지 않으므로 F2는 이전 동작 그대로다
 * (진행 중인 종목 배지·대결 보더를 F2가 조용히 지우는 회귀를 만들지 않는다).
 *
 * `liveOverlay`를 두 번째 인자로 받는 이유: 이 함수는 F1~F10과 런처 버튼이 공유하는
 * 유일한 빌더(U86)라, 씬만으로는 알 수 없는 "지금 오버레이가 퓨어인가"를 호출부가
 * 실어 보내야 한다. 생략하면(다른 씬 호출부·기존 테스트) 이 분기 자체가 꺼진다.
 */
export function sceneEntryAction(scene: SceneId, liveOverlay?: SceneOpts['liveOverlay']) {
  // 대기 화면의 정본은 **메인 키비주얼**이다. 사전미션·선서 모드는 큐시트가 명시적으로 건다.
  if (scene === 'standby') {
    return { type: 'scene/set', scene, opts: { standby: { mode: 'main' } } } as const;
  }
  // 스코어보드의 정본은 **전체 보드**다. 한 종목 공개는 큐시트가 명시적으로 건다.
  if (scene === 'score') {
    return { type: 'scene/set', scene, opts: { score: { highlight: null } } } as const;
  }
  if (scene === 'live' && liveOverlay && isPureCameraOverlay(liveOverlay)) {
    return { type: 'scene/set', scene, opts: { liveOverlay: { scorebar: true, timer: true } } } as const;
  }
  return { type: 'scene/set', scene } as const;
}

/**
 * 퓨어 카메라 — `liveOverlay`를 전부 끈 채 `live` 씬으로 (U131).
 *
 * 사용자 지시(2026-09-05 11:3x): "중계 오버레이 다 끄고 완전 퓨어 카메라로 보이는 옵션도
 * 만들어줘." `part2-live` 큐(U118)와 같은 `liveOverlayAllOff()`를 쓴다 — 차이는 `frame`
 * 하나뿐이다(2부 전환은 `dark-standby`, 여기는 맨 카메라라 `none`).
 *
 * 리플레이가 도는 중에 눌러도 리플레이는 멈추지 않는다 — `liveOverlayAllOff()`가
 * `replay`·`replayMarkAt`을 건드리지 않으므로 배지는 경고로 그대로 남는다.
 */
export function pureCameraAction() {
  return { type: 'scene/set' as const, scene: 'live' as const, opts: { liveOverlay: liveOverlayAllOff('none') } };
}

/**
 * 1부 씬 버튼. 순서의 정본은 이 배열이다 — 설정에서 켠 버튼도 여기 자리로 되돌아온다 (U66).
 *
 * `optional` 넷은 기본으로 내려 둔다. 사용자 지시가 "런처에서 시상·현장사진·출전 명단·영상
 * 재생을 빼 달라"이고, 넷 다 큐시트로 갈 수 있어 손이 막히지 않는다. `photos`는 F6도 살아 있다.
 */
const P1_BUTTONS: SceneBtn[] = [
  // 대기 화면만 한 줄을 통째로 쓴다 — 바로 아래 사진 배경 토글이 붙는 자리다 (U73)
  { scene: 'standby', key: 'F1', wide: true, tip: '키비주얼 대기 화면. 쉬는시간에도 이 씬(평온 유지).' },
  { scene: 'live', key: 'F2', tip: '카메라 풀 + 하단 스코어바 + 우상 타이머 + 좌상 종목 배지.' },
  { scene: 'score', key: 'F3', tip: '풀스크린 스코어보드. 순위 정렬 애니 + 점수 카운트업.' },
  { scene: 'timer', key: 'F4', tip: '풀스크린 타이머. 마지막 10초 레드 펄스(소리는 나지 않습니다).' },
  { scene: 'roster', optional: true, tip: '출전 선수 명단 카드. [출전 명단] 탭에서 입력한 내용.' },
  { scene: 'video', optional: true, tip: '등록된 영상 풀스크린 재생. [영상·에셋] 탭에서 선택.' },
  {
    scene: 'photos',
    key: 'F6',
    optional: true,
    tip: '현장에서 수집한 사진 슬라이드쇼. [현장 사진] 탭에서 폴더 연결·숨김 관리.',
  },
  { scene: 'award', optional: true, tip: '시상 리빌. [시상] 탭 버튼으로 단계 진행.' },
];

function sceneButton(ctx: Ctx, b: SceneBtn, locked: boolean): HTMLElement {
  const active = ctx.state.scene === b.scene;
  return el(
    'button',
    {
      class: `scene-btn${b.wide ? ' scene-btn--wide' : ''}${active ? ' is-active' : ''}${locked ? ' is-locked' : ''}`,
      type: 'button',
      disabled: locked,
      data: { tip: locked ? '잠겨 있습니다 — 아래 [잠금 해제] 후 사용할 수 있습니다.' : b.tip },
      on: {
        click: () => {
          if (locked) return;
          ctx.dispatch(sceneEntryAction(b.scene, ctx.state.sceneOpts.liveOverlay));
        },
      },
    },
    // 상태는 색(점) + 형태(링) + 텍스트(태그) 셋으로 동시에 알린다
    el('span', { class: 'scene-btn__dot' }),
    el('span', { class: 'scene-btn__label', text: SCENE_LABELS[b.scene] }),
    // 태그·키캡은 라벨과 같은 줄에 두면 좁은 2열 그리드에서 라벨을 잘라먹는다 — 아랫줄로 내린다
    el(
      'span',
      { class: 'scene-btn__meta' },
      locked || active ? el('span', { class: 'scene-btn__state', text: locked ? 'LOCK' : 'PGM' }) : null,
      b.key ? el('span', { class: 'scene-btn__key mono-label', text: b.key }) : null,
    ),
  );
}

export function standbyBackdropQuickToggle(settings: PhotoSettings): {
  text: string;
  pressed: boolean;
} {
  const pressed = settings.standbyBackdrop;
  return {
    text: pressed ? '☑ 사진 배경 켬' : '☐ 사진 배경 끔',
    pressed,
  };
}

export function launcherTransitionOptions(mode: SceneTransitionMode): {
  id: SceneTransitionMode;
  label: string;
  pressed: boolean;
}[] {
  return [
    { id: 'white', label: '화이트', pressed: mode === 'white' },
    { id: 'black', label: '블랙', pressed: mode === 'black' },
    { id: 'stinger', label: '스팅어', pressed: mode === 'stinger' },
  ];
}

/**
 * 대결팀 보더 — 씬 런처 안, 라이브 씬 버튼 바로 아래 (결정 U14 · 시안 A · Split Color Tiles).
 *
 * 카메라 전환과 대결 조합 선택을 같은 시선 안에서 끝내려고 1부 탭이 아니라 런처에 둔다.
 * 타일은 버튼 절반씩 좌·우 팀 색 면이라, 누르기 전에 출력 보더의 방향이 그대로 보인다.
 * 색은 팀 설정의 실제 값을 읽는다 — 팀 이름·색을 바꾸면 타일도 따라 바뀐다.
 */
function versusBox(ctx: Ctx): HTMLElement {
  const collapsed = ctx.state.settings.launcherVersusCollapsed;
  const current = ctx.state.sceneOpts.liveOverlay.versus;
  const teamOf = (id: Parameters<typeof getTeam>[1]) => getTeam(ctx.state, id);
  const options = versusPairOptions(activeTeamIds(ctx.state), current, teamOf, ctx.state.assets);
  const status = versusStatusLabel(current, teamOf);

  const tiles: HTMLButtonElement[] = [];
  // roving tabindex — Tab 한 번에 그룹 안으로 들어오고, 안에서는 방향키로 옮긴다
  const selectedIndex = options.findIndex((o) => o.selected);
  const entryIndex = selectedIndex >= 0 ? selectedIndex : 0;

  const focusAt = (index: number) => {
    for (const tile of tiles) tile.tabIndex = -1;
    const target = tiles[index];
    if (!target) return;
    target.tabIndex = 0;
    target.focus();
  };

  options.forEach((option, index) => {
    tiles.push(
      el(
        'button',
        {
          class: `vspair${option.selected ? ' is-on' : ''}`,
          type: 'button',
          tabIndex: index === entryIndex ? 0 : -1,
          style: `--vs-l:${option.left.color};--vs-r:${option.right.color}`,
          attrs: { 'aria-pressed': option.selected ? 'true' : 'false' },
          data: { fid: option.fid, tip: option.tip },
          on: {
            // 좌측 절반 = 보더만, 우측 절반 = 보더 + 매치 영상 (U63). 재생 중 다른 타일을 눌러도
            // `overlay/play`의 restartToken이 바뀌므로 display가 옛 소스를 정리하고 교체한다.
            click: (ev) => {
              const me = ev as MouseEvent;
              const rect = (me.currentTarget as HTMLElement).getBoundingClientRect();
              const withVideo =
                versusTileHalf(me.clientX, rect, me.shiftKey, me.detail) === 'play';
              ctx.dispatch(versusTileActions(option, Date.now(), withVideo));
              if (withVideo && option.matchAssetId) toast('매치 영상을 재생합니다');
            },
            keydown: (ev) => {
              // Space가 window까지 새 나가면 전역 단축키(hotkeys.ts)가 타이머를 토글해 버린다.
              // 여기서는 전파만 끊는다 — preventDefault를 하면 keyup의 네이티브 버튼 활성화가 죽는다.
              if (ev.code === 'Space') {
                ev.stopPropagation();
                return;
              }
              const next = nextVersusFocus(ev.key, index, options.length);
              if (next === null) return;
              ev.preventDefault();
              ev.stopPropagation();
              focusAt(next);
            },
          },
        },
        el('span', { class: 'vspair__face vspair__face--l' }),
        el('span', { class: 'vspair__face vspair__face--r' }),
        /**
         * 좌·우 절반의 hover 판정 면 (U63). 버튼을 둘로 쪼개지 않는 이유는 roving tabindex와
         * 방향키 내비게이션이 깨지기 때문이다 — 이 둘은 버튼 **안쪽** 장식 span이라 클릭은
         * 그대로 버튼으로 버블링하고, 어느 절반이 밝아졌는지만 눈으로 알려 준다.
         * 실제 판정은 좌표로 하므로(`versusTileHalf`) 이 면이 없어도 동작은 같다.
         */
        el('span', { class: 'vspair__half vspair__half--l' }),
        el('span', { class: 'vspair__half vspair__half--r' }),
        // 영상 유무를 색이 아니라 글자로도 알린다 — 누르기 전에 무엇이 일어날지 보인다
        el('span', {
          class: `vspair__vid${option.matchAssetId ? ' is-on' : ''}`,
          text: option.matchAssetId ? '▶' : '—',
          attrs: { 'aria-label': option.matchAssetId ? '매치 영상 있음' : '매치 영상 없음' },
        }),
        el(
          'span',
          { class: 'vspair__text' },
          el('strong', { class: 'vspair__name vspair__name--l', text: option.left.name }),
          // 선택 상태는 색·테두리만이 아니라 글자(✓)로도 알린다
          el('em', { class: 'vspair__vs', text: option.selected ? '✓ ON' : 'VS' }),
          el('strong', { class: 'vspair__name vspair__name--r', text: option.right.name }),
        ),
      ),
    );
  });

  return el(
    'div',
    { class: `vsbox${collapsed ? ' is-collapsed' : ''}` },
    /**
     * 카드 머리 = 접기 토글 (U57). 상태 칩을 머리 안에 그대로 두는 이유는, 접어 둔 채로도
     * "지금 어느 조합이 나가고 있나"는 항상 보여야 하기 때문이다. 칩은 버튼 안의 span이라
     * 클릭하면 카드가 접힌다 — 칩 자체에는 누를 동작이 없으므로 충돌하지 않는다.
     */
    el(
      'button',
      {
        class: 'vsbox__head vsbox__toggle',
        type: 'button',
        attrs: { 'aria-expanded': collapsed ? 'false' : 'true' },
        data: {
          fid: 'versus-collapse',
          tip: `${
            collapsed
              ? '대결 조합 타일을 펼칩니다. 접어 두어도 지금 나가는 조합은 오른쪽 글자로 계속 보입니다.'
              : '대결 조합 타일을 접어 런처 세로 길이를 줄입니다. 접힌 상태는 저장되어 다음에 열 때도 유지됩니다.'
          } ${versusStatusTip(current, teamOf)}`,
        },
        on: {
          click: () =>
            ctx.dispatch({
              type: 'settings/patch',
              patch: { launcherVersusCollapsed: !collapsed },
            }),
        },
      },
      // 접힘 상태도 색이 아니라 형태(▸/▾) + 텍스트로 알린다
      el('span', { class: 'vsbox__caret', text: collapsed ? '▸' : '▾' }),
      el('span', { class: 'vsbox__title', text: '대결팀 보더' }),
      el('span', {
        class: `vsbox__status${current ? ' is-on' : ''}`,
        text: status,
        data: { fid: 'versus-status', tip: versusStatusTip(current, teamOf) },
      }),
    ),
    el(
      'div',
      { class: 'vsbox__body', attrs: { hidden: collapsed ? 'hidden' : undefined } },
      el('div', { class: 'vsbox__pairs', attrs: { role: 'group', 'aria-label': '대결 팀 조합' } }, tiles),
      el(
        'div',
        { class: 'vsbox__tools' },
        el('button', {
          class: 'vsbox__tool',
          type: 'button',
          disabled: !current,
          text: '↔ 좌우 바꾸기',
          data: { fid: 'versus-swap', tip: '선택한 두 팀은 유지하고 출력의 좌·우 위치만 맞바꿉니다.' },
          on: {
            click: () =>
              ctx.dispatch({
                type: 'sceneOpts/patch',
                patch: { liveOverlay: { versus: swapTeamPair(current) } },
              }),
          },
        }),
        el('button', {
          class: 'vsbox__tool is-danger',
          type: 'button',
          disabled: !current,
          text: '보더 끄기',
          data: { fid: 'versus-off', tip: '보더와 팀 아이콘을 모두 내리고 공통 톤으로 되돌립니다.' },
          on: {
            click: () =>
              ctx.dispatch({ type: 'sceneOpts/patch', patch: { liveOverlay: { versus: null } } }),
          },
        }),
      ),
    ),
  );
}

/**
 * 슬로우 리플레이 **왼쪽 반쪽** 상태 — 라벨·비활성 사유·버퍼 칩을 한 순수 함수에서 낸다 (Q5).
 *
 * 눌렀는데 아무 일도 안 일어나는 것이 현장에서 가장 나쁘므로, 못 누르는 이유를
 * 툴팁에 그대로 적는다. 단축키 `R`도 같은 조건을 토스트로 말한다(`control.ts`).
 *
 * U85에서 버튼이 반으로 갈렸다 — 이 함수는 "마지막 `replaySec`초"를 맡는 왼쪽 반쪽이고,
 * "여기서부터 여기까지"를 맡는 오른쪽 반쪽은 `replayMarkControlState()`다.
 */
export function replayControlState(input: {
  playing: boolean;
  scene: string;
  enabled: boolean;
  bufferedSec: number;
  replaySec: number;
  rate: number;
}): { label: string; disabled: boolean; tip: string; buffer: string; bufferTip: string } {
  const buffer = `버퍼 ${Math.max(0, Math.trunc(input.bufferedSec))}초`;
  const bufferTip = `지금 되감을 수 있는 길이입니다. 중계 화면에 서 있는 동안 계속 녹화해 최대 ${input.replaySec}초까지 찹니다. 한 번 되감으면 그 구간을 꺼내 쓰므로 버퍼가 줄었다가 다시 차오릅니다 — 연달아 되감으면 두 번째는 짧게 나가고, 원래 길이를 회복하는 데 최대 ${input.replaySec}초가 걸립니다. 씬을 떠나면 버퍼를 놓습니다.`;
  if (input.playing) {
    return {
      label: '■ 라이브 복귀',
      disabled: false,
      tip: '되감기를 멈추고 지금 카메라 화면으로 돌아갑니다. 끝까지 두면 저절로 돌아옵니다.',
      buffer,
      bufferTip,
    };
  }
  const label = '⏪ 리플레이';
  if (input.scene !== 'live') {
    return { label, disabled: true, tip: '중계 화면(F2)에서만 되감을 수 있습니다.', buffer, bufferTip };
  }
  if (!input.enabled) {
    return {
      label,
      disabled: true,
      tip: '슬로우 리플레이가 꺼져 있습니다 — [설정] 탭에서 켜세요. 꺼 두면 녹화 자체를 하지 않습니다.',
      buffer,
      bufferTip,
    };
  }
  if (input.bufferedSec < 1) {
    return {
      label,
      disabled: true,
      tip: '되감을 화면이 아직 없습니다. 중계 화면에 몇 초 더 서 있으면 버퍼가 찹니다.',
      buffer,
      bufferTip,
    };
  }
  return {
    label,
    disabled: false,
    // 배속 표기는 배지·상단 칩과 **같은 포맷터**를 쓴다 — 세 자리가 다른 문자열을 보이면
    // 운영자가 "지금 몇 배속인가"를 화면마다 다시 읽게 된다
    tip: `마지막 ${input.replaySec}초를 ${formatReplayRate(input.rate)}배속으로 카메라 위에 띄웁니다. 들어가고 나오는 컷은 짧은 스팅어가 덮습니다. 끝나면 저절로 라이브로 돌아옵니다. 소리는 나가지 않습니다. 구간을 직접 잡으려면 오른쪽 [지금부터]를 쓰세요.`,
    buffer,
    bufferTip,
  };
}

/**
 * 찍어 둔 구간이 지금 몇 초인지 (U85). 200ms마다 이 문자열만 갈아 끼운다.
 *
 * 소수를 보이지 않는 이유는 200ms 갱신에서 `4.3초 → 4.5초 → 4.7초`가 눈에 떨리게 읽히기
 * 때문이다. 재생에 쓰는 값은 반올림하지 않은 실측 그대로다(`control.ts`) — 화면 표기만 정수다.
 * 마크가 `now - 1000`이라 찍자마자 1초부터 시작한다.
 */
export function replayMarkLabel(elapsedMs: number): string {
  return `${Math.max(1, Math.round(elapsedMs / 1000))}초`;
}

/**
 * 슬로우 리플레이 **오른쪽 반쪽** = [지금부터] 상태 (U85).
 *
 * 사용자 원문: "10초는 좀 긴 것 같아. 버튼을 반으로 쪼개고 '지금부터' 버튼을 만들어줘.
 * 그걸 누르면 누른 시점 1초 전부터 메모리에 담겨서 그 구간만큼만 재생되도록."
 *
 * 세 얼굴을 가진다: 재생 중이면 `■ 라이브 복귀`(어느 반쪽을 눌러도 멈춘다), 찍은 것이
 * 없으면 `⏺ 지금부터`, 찍어 둔 구간이 있으면 `▶ 여기까지` + 자라는 초 표시.
 *
 * **찍는 단계는 버퍼를 따지지 않는다.** 지금 버퍼가 비었어도 그것은 "몇 초 뒤에는 찬다"는
 * 뜻이라, 시작점을 못 찍게 막으면 정작 담고 싶은 장면의 앞머리를 놓친다. 되감을 것이
 * 있는지는 두 번째 누름에서 따진다.
 */
export function replayMarkControlState(input: {
  playing: boolean;
  scene: string;
  enabled: boolean;
  bufferedSec: number;
  markAt: number | null;
  now: number;
  rate: number;
}): { label: string; mark: string | null; disabled: boolean; tip: string } {
  if (input.playing) {
    return {
      label: '■ 라이브 복귀',
      mark: null,
      disabled: false,
      tip: '되감기를 멈추고 지금 카메라 화면으로 돌아갑니다. 나가는 컷도 스팅어가 덮습니다. 끝까지 두면 저절로 돌아옵니다.',
    };
  }
  const marked = input.markAt !== null;
  const label = marked ? '▶ 여기까지' : '⏺ 지금부터';
  const mark = input.markAt === null ? null : replayMarkLabel(input.now - input.markAt);
  if (input.scene !== 'live') {
    return { label, mark, disabled: true, tip: '중계 화면(F2)에서만 구간을 잡을 수 있습니다.' };
  }
  if (!input.enabled) {
    return {
      label,
      mark,
      disabled: true,
      tip: '슬로우 리플레이가 꺼져 있습니다 — [설정] 탭에서 켜세요. 꺼 두면 녹화 자체를 하지 않습니다.',
    };
  }
  if (!marked) {
    return {
      label,
      mark,
      disabled: false,
      tip: '지금 이 순간을 구간 시작점으로 찍습니다 (실제로는 누른 시점 1초 전부터 — 손이 가는 순간에는 이미 그 장면이 지나가 있습니다). 다시 누르면 거기서부터 그때까지를 되감습니다. 단축키 Shift+R.',
    };
  }
  if (input.bufferedSec < 1) {
    return {
      label,
      mark,
      disabled: true,
      tip: '되감을 화면이 아직 없습니다. 중계 화면에 몇 초 더 서 있으면 버퍼가 찹니다. 찍어 둔 시작점은 그대로 있습니다.',
    };
  }
  return {
    label,
    mark,
    disabled: false,
    tip: `찍어 둔 시작점부터 지금까지를 ${formatReplayRate(input.rate)}배속으로 띄웁니다. 버퍼가 그 구간을 못 채우면 있는 만큼만 나가고 그 사실을 알립니다. Shift+클릭하면 찍어 둔 구간을 지웁니다. 단축키 Shift+R.`,
  };
}

/**
 * 리플레이 칸 (U81 자리 · U85 반쪽 분할) — 씬 그리드의 한 칸, **[경기 중계] 바로 오른쪽**이다.
 *
 * 되감기는 중계 화면 조작이라 그 버튼 옆이 손이 가는 자리다. 예전에는 대결 카드 아래 별도
 * 박스(`replaybox`)로 떨어져 있어, 중계 중에 시선이 런처 위아래를 오갔다.
 *
 * ## 왜 반으로 갈렸나 (U85)
 * 사용자 지시가 "10초는 좀 긴 것 같아. 버튼을 반으로 쪼개고 '지금부터' 버튼을 만들어줘"다.
 * 왼쪽은 예전 그대로 마지막 `replaySec`초, 오른쪽은 운영자가 두 번 눌러 잡는 구간이다.
 * **한 칸 안에서** 갈린다 — 격자 배치(2열)와 아래 줄들이 그대로 유지된다.
 * 둘 다 진짜 `<button>`이고 DOM 순서가 왼쪽 → 오른쪽이라 Tab이 보이는 순서대로 돈다.
 *
 * ## 왜 `disabled`를 쓰지 않는가
 * 버퍼가 없거나 씬이 다르면 예전에는 버튼이 `disabled`였다. 그러면 (1) 안에 든 버퍼 칩의
 * 툴팁이 hover·focus 어느 쪽으로도 열리지 않고(비활성 버튼은 포인터 이벤트를 먹지 않는다),
 * (2) 눌러도 **아무 일이 없어** 이유를 알 수 없다. 단축키 `R`은 이미 거절 사유를 토스트로
 * 말하고 있었으므로, 버튼도 같은 입구(`ctx.toggleReplay()`)를 그대로 타게 해서 두 경로를
 * 하나로 맞춘다. 못 누르는 상태는 `aria-disabled` + 색·텍스트로 알린다.
 */
function replayButton(ctx: Ctx): HTMLElement {
  const s = ctx.state;
  const overlay = s.sceneOpts.liveOverlay;
  const playing = overlay.replay !== null;
  const bufferedSec = ctx.status.replayBufferSec ?? 0;
  const view = replayControlState({
    playing,
    scene: s.scene,
    enabled: s.settings.replayEnabled,
    bufferedSec,
    replaySec: s.settings.replaySec,
    rate: s.settings.replayRate,
  });
  const markView = replayMarkControlState({
    playing,
    scene: s.scene,
    enabled: s.settings.replayEnabled,
    bufferedSec,
    markAt: overlay.replayMarkAt,
    now: Date.now(),
    rate: s.settings.replayRate,
  });

  const left = el(
    'button',
    {
      class: `scene-btn scene-btn--replay scene-btn--half${view.disabled ? ' is-off' : ' is-ready'}`,
      type: 'button',
      attrs: { 'aria-disabled': view.disabled ? 'true' : 'false' },
      data: { fid: 'replay-toggle', tip: view.tip },
      on: { click: () => ctx.toggleReplay() },
    },
    el('span', { class: 'scene-btn__label', text: view.label }),
    el(
      'span',
      { class: 'scene-btn__meta' },
      // 버퍼 칩은 버튼 **안**에 산다 — 되감을 수 있는지와 누를 수 있는지가 같은 정보라
      // 둘이 떨어져 있으면 눈이 두 곳을 대조하게 된다
      el('span', {
        class: `scene-btn__buffer${bufferedSec >= 1 ? ' is-on' : ''}`,
        text: view.buffer,
        data: { tip: view.bufferTip },
      }),
      el('span', { class: 'scene-btn__key mono-label', text: 'R' }),
    ),
  );

  const right = el(
    'button',
    {
      class: `scene-btn scene-btn--replay scene-btn--half scene-btn--mark${markView.disabled ? ' is-off' : ' is-ready'}${markView.mark ? ' is-marked' : ''}`,
      type: 'button',
      attrs: { 'aria-disabled': markView.disabled ? 'true' : 'false' },
      data: { fid: 'replay-mark', tip: markView.tip },
      on: {
        // Shift+클릭은 취소다 — 잘못 찍은 시작점을 지우려고 굳이 되감아 볼 이유가 없다
        click: (ev) => (ev.shiftKey ? ctx.clearReplayMark() : ctx.toggleReplayMark()),
      },
    },
    el(
      'span',
      { class: 'scene-btn__label' },
      markView.label,
      /**
       * 자라는 초 표시만 별도 노드다 — 200ms마다 `render()`를 돌리면 조작 중인 입력의
       * 포커스·드래그가 끊긴다. `control.ts`의 `paintReplayMark()`가 이 자리의
       * `textContent`만 갈아 끼운다(타이머·영상 진행 바와 같은 관례).
       */
      markView.mark === null
        ? null
        : el('span', {
            class: 'scene-btn__mark mono-label',
            text: markView.mark,
            data: { live: 'replay-mark' },
          }),
    ),
    el(
      'span',
      { class: 'scene-btn__meta' },
      el('span', { class: 'scene-btn__key mono-label', text: '⇧R' }),
    ),
  );

  return el('div', { class: 'scene-btn-split' }, left, right);
}

/**
 * [경기 중계] 칸 — 기본 크롬 반쪽과 [퓨어] 반쪽으로 갈린다 (U131).
 *
 * 사용자 지시(2026-09-05 11:3x): "중계 오버레이 다 끄고 완전 퓨어 카메라로 보이는 옵션도
 * 만들어줘." U81 격자의 `[경기 중계][리플레이]` 줄을 깨지 않으려고 리플레이와 같은
 * 반쪽 분할(`scene-btn-split`, U85)을 재사용한다 — 새 칸을 하나 더 만들면 스코어보드·
 * 타이머가 한 줄 더 내려가고, `[중계]` 옆 자리는 이미 리플레이가 쓰고 있다.
 *
 * 왼쪽은 예전 [경기 중계]와 완전히 같다 — 같은 빌더(`sceneEntryAction`), 같은 F2. 오른쪽은
 * 새 [퓨어]다 — 크롬 넷을 한 번에 끄는 프리셋(`pureCameraAction`)이고 단축키는 `Shift+F2`.
 * 지금 씬이 `live`인지와 오버레이가 퓨어 상태인지를 각각 봐서 PGM 표시를 반쪽에 나눠 준다
 * — 한 씬의 두 얼굴이 동시에 송출될 수 없으므로 PGM은 항상 한쪽에만 붙는다.
 */
function liveSceneButton(ctx: Ctx, b: SceneBtn): HTMLElement {
  const s = ctx.state;
  const overlay = s.sceneOpts.liveOverlay;
  const onLive = s.scene === 'live';
  const pure = isPureCameraOverlay(overlay);

  const chrome = el(
    'button',
    {
      class: `scene-btn scene-btn--half${onLive && !pure ? ' is-active' : ''}`,
      type: 'button',
      data: { fid: 'live-chrome', tip: b.tip },
      on: { click: () => ctx.dispatch(sceneEntryAction('live', overlay)) },
    },
    el('span', { class: 'scene-btn__label', text: SCENE_LABELS[b.scene] }),
    el(
      'span',
      { class: 'scene-btn__meta' },
      onLive && !pure ? el('span', { class: 'scene-btn__state', text: 'PGM' }) : null,
      el('span', { class: 'scene-btn__key mono-label', text: 'F2' }),
    ),
  );

  const pureBtn = el(
    'button',
    {
      class: `scene-btn scene-btn--half scene-btn--pure${onLive && pure ? ' is-active' : ''}`,
      type: 'button',
      data: {
        fid: 'live-pure',
        tip: '스코어바·타이머·종목 배지·대결 보더를 전부 끄고 카메라만 내보냅니다. [경기 중계]를 다시 누르면 스코어바·타이머가 돌아옵니다. 단축키 Shift+F2.',
      },
      on: { click: () => ctx.dispatch(pureCameraAction()) },
    },
    el('span', { class: 'scene-btn__label', text: '퓨어' }),
    el(
      'span',
      { class: 'scene-btn__meta' },
      onLive && pure ? el('span', { class: 'scene-btn__state', text: 'PGM' }) : null,
      el('span', { class: 'scene-btn__key mono-label', text: '⇧F2' }),
    ),
  );

  return el('div', { class: 'scene-btn-split' }, chrome, pureBtn);
}

/**
 * 지금 런처에 그릴 씬 버튼 (U66). 순서는 `P1_BUTTONS`가 쥐고, 선택 씬은 설정이 켠 것만 남는다.
 * 설정에 없는 키는 `normalizeLauncherExtraScenes`가 이미 걸러 왔으므로 여기서는 읽기만 한다.
 */
export function launcherSceneButtons(
  extras: Record<LauncherExtraSceneId, boolean>,
): { scene: SceneId; key?: string }[] {
  return visibleSceneButtons(extras).map((b) => ({ scene: b.scene, key: b.key }));
}

function visibleSceneButtons(extras: Record<LauncherExtraSceneId, boolean>): SceneBtn[] {
  return P1_BUTTONS.filter((b) => !b.optional || extras[b.scene as LauncherExtraSceneId] === true);
}

/**
 * 암전 토글의 화면 표시 (U65) — 순수 계산이라 여기서 뽑아 테스트한다.
 *
 * 켬/끔은 **색 + 형태 + 텍스트** 셋으로 동시에 알린다(위험 조작이므로 하나만으로는 부족하다).
 * 램프가 도는 동안에는 남은 초를 함께 보여 준다 — 5초짜리 페이드는 누른 직후 화면이 거의
 * 그대로라, 숫자가 없으면 운영자가 "안 먹었나" 하고 한 번 더 누른다(그러면 되돌아간다).
 */
export function blackoutToggleView(active: boolean, remainingSec: number): {
  label: string;
  pressed: boolean;
  ramping: boolean;
} {
  return {
    label: active ? '■ 암전 해제' : '● 화면 암전',
    pressed: active,
    ramping: remainingSec > 0,
  };
}

export function renderLauncher(ctx: Ctx): HTMLElement {
  const locked = !ctx.state.p2.unlocked;
  const backdropToggle = standbyBackdropQuickToggle(ctx.state.photos.settings);

  /**
   * 사진 배경 토글은 **대기 화면 버튼 바로 아래** 한 줄이다 (U73).
   *
   * 이 조작이 뜻을 갖는 씬은 대기 화면 하나뿐인데, 예전에는 런처 맨 아래 —— 대결 카드와
   * 리플레이 박스를 지나 —— 떨어져 있어서 "무엇의 배경인가"가 화면에서 읽히지 않았다.
   * 켬/끔은 체크 글자 + `aria-pressed` + `is-on` 색 셋으로 동시에 알린다.
   */
  const photoToggle = el('button', {
    class: `launcher__photo-toggle${backdropToggle.pressed ? ' is-on' : ''}`,
    type: 'button',
    text: backdropToggle.text,
    attrs: { 'aria-pressed': backdropToggle.pressed ? 'true' : 'false' },
    data: {
      fid: 'photo-backdrop-quick',
      tip: '바로 위 [대기 화면] 씬에서 그래픽 뒤에 현장 사진을 은은하게 깔지 정합니다. 끄면 키비주얼만 남습니다. 켜고 끄는 순간 크로스디졸브로 넘어가며 [현장 사진] 탭 설정과 같은 값입니다.',
    },
    on: {
      click: () => {
        ctx.dispatch({
          type: 'photos/settings',
          patch: { standbyBackdrop: !backdropToggle.pressed },
        });
      },
    },
  });

  const unlockBtn = el('button', {
    class: 'btn btn--danger btn--block',
    type: 'button',
    text: '잠금 해제',
    data: {
      fid: 'p2-unlock',
      tip: '해제하면 출력 화면에 후반부 요소가 노출될 수 있습니다. 확인 2단계. 해제한 뒤 다시 잠그는 것은 [2부 컨트롤] 탭에서 합니다.',
    },
    on: {
      click: () => {
        openModal({
          title: '잠금 해제',
          body: '해제하면 출력 화면에 후반부 요소가 노출될 수 있습니다. 프로젝터 화면이 대기 화면인지 확인한 뒤 진행하세요. 계속하려면 OPEN 을 입력하세요.',
          danger: true,
          confirmLabel: '해제',
          requireText: 'OPEN',
          onConfirm: () => {
            ctx.dispatch({ type: 'p2/unlock' });
            toast('잠금이 해제되었습니다 — 2부 조작은 [2부 컨트롤] 탭에 있습니다', 'warn');
          },
        });
      },
    },
  });

  /**
   * 화면 암전 (U65) — 런처 **최상단**, 전환 방식 줄보다 위다.
   *
   * 사고가 났을 때 제일 먼저 찾는 손잡이라 어디에도 묻히면 안 된다. 위험 조작이므로
   * 단축키는 두지 않는다(F1~F10·Space·B가 이미 손에 붙어 있어 오조작 거리가 0이 된다) —
   * 이 버튼 하나가 유일한 경로다.
   */
  const bo = ctx.state.sceneOpts.blackout;
  const boTarget = blackoutTarget(bo.active);
  const boRemaining = blackoutRemainingSec(
    Date.now() - bo.startedAt,
    blackoutDurationMs(ctx.state.settings.blackoutSec, bo.fromOpacity, boTarget),
  );
  const boView = blackoutToggleView(bo.active, boRemaining);
  const blackoutBtn = el(
    'button',
    {
      class: `launcher__blackout${boView.pressed ? ' is-on' : ''}${boView.ramping ? ' is-ramping' : ''}`,
      type: 'button',
      attrs: {
        'aria-pressed': boView.pressed ? 'true' : 'false',
        'aria-label': boView.pressed ? '암전 해제' : '화면 암전',
      },
      data: {
        fid: 'blackout-toggle',
        tip: `출력 화면만 검정으로 덮습니다 — 소리는 그대로 나갑니다(음악·영상 소리를 함께 줄이려면 상단 볼륨을 쓰세요). 켜고 끄는 데 각각 ${ctx.state.settings.blackoutSec}초가 걸리고(설정 탭 [페이드 → 암전 페이드]), 페이드 도중 다시 누르면 지금 밝기에서 그대로 되돌아옵니다. 오조작을 막기 위해 단축키는 없습니다.`,
      },
      on: {
        click: () => ctx.dispatch({ type: 'blackout/set', on: !bo.active, now: Date.now() }),
      },
    },
    el('span', { class: 'launcher__blackout-label', text: boView.label }),
    // 남은 초는 200ms 루프가 여기에만 다시 써 넣는다 (전체 재렌더 없이 — 큐시트 포커스 보존)
    el('span', {
      class: 'launcher__blackout-count',
      text: boRemaining > 0 ? `${boRemaining}초` : '',
      data: { live: 'blackout-count' },
    }),
  );

  return el(
    'aside',
    { class: 'launcher' },
    el('h2', { class: 'panel__title', text: '씬 런처' }),
    blackoutBtn,
    el(
      'div',
      { class: 'launcher__transition', attrs: { role: 'group', 'aria-label': '씬 전환 방식' } },
      el('span', { class: 'launcher__transition-label mono-label', text: '전환 방식' }),
      el(
        'div',
        { class: 'launcher__transition-options' },
        launcherTransitionOptions(ctx.state.settings.sceneTransitionMode).map((option) =>
          el('button', {
            class: `launcher__transition-btn${option.pressed ? ' is-on' : ''}`,
            type: 'button',
            text: option.label,
            attrs: { 'aria-pressed': option.pressed ? 'true' : 'false' },
            data: { fid: `launcher-transition-${option.id}` },
            on: {
              click: () =>
                ctx.dispatch({ type: 'settings/patch', patch: { sceneTransitionMode: option.id } }),
            },
          }),
        ),
      ),
    ),
    el(
      'div',
      { class: 'launcher__grid' },
      visibleSceneButtons(ctx.state.settings.launcherExtraScenes).flatMap((b) =>
        // 대기 화면 버튼 다음 칸에 사진 배경 토글이 들어간다 — 둘 다 한 줄을 통째로 쓰므로
        // 나머지 버튼의 2열 배치는 그대로다. 경기 중계 다음 칸은 리플레이다 (U81) —
        // 그 결과 스코어보드·타이머가 한 줄 아래로 내려가 2열 배치가 그대로 이어진다.
        b.scene === 'standby'
          ? [sceneButton(ctx, b, false), photoToggle]
          : b.scene === 'live'
            ? [liveSceneButton(ctx, b), replayButton(ctx)]
            : [sceneButton(ctx, b, false)],
      ),
    ),
    // U81 — 리플레이 박스(`replaybox`)를 걷어냈다. 되감기 조작은 씬 그리드 안
    // [경기 중계] 바로 오른쪽 칸으로 올라갔다.
    versusBox(ctx),
    /**
     * U49 — `UNLOCKED · 별도 묶음` 퀵 카드를 걷어냈다.
     *
     * 해제하고 나면 이 카드가 런처 아래에 상시로 남아, 1부 내내 후반부 씬 버튼 세 개가
     * 조작 화면에 떠 있었다. 잠금의 뜻은 "그 화면을 아직 안 쓴다"인데 버튼이 손에 닿는
     * 자리에 있으면 오조작 거리가 0이다. 후반부 씬 이동은 [2부 컨트롤] 탭과 F9/F10이 맡는다.
     *
     * **[잠금 해제]만 여기 남는다** — 잠긴 동안에는 [2부 컨트롤] 탭 자체가 비활성이라
     * 해제 버튼을 그 안에 두면 열 방법이 사라진다. 해제된 뒤의 [다시 잠그기]는 [2부 컨트롤] 탭에 있다.
     */
    locked ? unlockBtn : null,
  );
}
