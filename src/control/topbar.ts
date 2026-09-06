import { SCENE_LABELS, isDegraded, pickScene } from '../scenes';
import { isPureCameraOverlay } from '../live-frame';
import { el } from './dom';
import { EVENT_MARK_SRC } from '../scenes/luxe-grid';
import { formatMMSS, isRunning, remainingSec } from '../timer';
import { volumePercent } from '../output-audio';
import {
  VOLUME_AXES,
  VOLUME_AXIS_LABEL,
  MASTER_RAMP_DUCK_TARGET,
  VOLUME_AXIS_TIP,
  effectiveVolume,
} from '../volume-ramp';
import {
  AUDIO_LOCK_OPEN_DISPLAY_TIP,
  AUDIO_LOCK_TITLE,
  audioLockLevel,
  audioLockMessage,
} from '../audio-lock';
import { USER_MUTE_CHIP, USER_MUTE_CHIP_TIP, userMuteChipVisible } from '../display-windowed';
import { videoAudioOwnsOutput } from '../music-duck';
import { bookmarkOf } from '../music-bookmarks';
import {
  MUSIC_REPEAT_MARK,
  MUSIC_REPEAT_MODES,
  MUSIC_REPEAT_TIP,
  stepTrackId,
} from '../music-autoplay';
import { formatMusicTime, musicTrack } from '../music';
import { formatReplayRate } from '../replay-ring';
import { freezeToggleView } from '../pgm';
import { livePosition } from './tab-music';
import type { VolumeAxis } from '../types';
import type { Ctx } from './ctx';

/**
 * 볼륨 램프 버튼 (U43). 축마다 같은 두 개가 붙는다 (U45).
 *
 * 두 개뿐인 이유: 현장에서 실제로 쓰는 동작은 "말할 동안 깔아 두기"와 "원래대로"뿐이다.
 * 중간값은 슬라이더가 답이고, 버튼을 늘리면 상단 바가 숫자밭이 된다.
 */
export function masterRampChoices(): { id: string; target: number; label: string }[] {
  return [
    // 라벨은 목표값에서 만든다 — 숫자와 글자를 따로 적으면 한쪽만 고치고 끝난다 (U74).
    {
      id: 'duck',
      target: MASTER_RAMP_DUCK_TARGET,
      label: `→${Math.round(MASTER_RAMP_DUCK_TARGET * 100)}%`,
    },
    { id: 'full', target: 1, label: '→100%' },
  ];
}

/**
 * 램프가 도는 동안 그 축의 슬라이더와 `%` 글자를 따라가게 한다 (U43 · U45).
 *
 * 전체 재렌더를 쓰지 않는 이유는 `paintMusicProgress`와 같다 — 매 프레임 트리를 새로 만들면
 * 포커스·스크롤·애니메이션이 전부 리셋된다. 사용자가 슬라이더를 잡고 있으면 손을 대지 않는다
 * (그 순간 램프는 이미 취소된 뒤지만, 취소 방송이 도착하기 전 한 프레임을 막는다).
 * 축을 선택자에 넣는 이유는 한 축의 램프가 **다른 축 슬라이더를 끌고 가면 안 되기** 때문이다.
 */
export function paintVolumeReadout(axis: VolumeAxis, volume: number): void {
  const percent = volumePercent(volume);
  const scope = `[data-axis="${axis}"]`;
  for (const node of document.querySelectorAll<HTMLInputElement>(`${scope} .volume-slider__input`)) {
    if (document.activeElement === node) continue;
    node.value = String(percent);
    node.setAttribute('aria-valuetext', `${percent}%`);
  }
  for (const node of document.querySelectorAll<HTMLElement>(`${scope} .volume-slider__value`)) {
    node.textContent = `${percent}%`;
  }
}

const PHASE_LABEL: Record<string, string> = {
  pre: '개회 전',
  p1: '1부',
  break: '쉬는시간',
  p2: '2부',
  award: '시상',
  end: '종료',
};

/** 정보 묶음 구분자 — 선이 아니라 점. 상단 바에 각진 요소를 늘리지 않는다. */
function sep(): HTMLElement {
  return el('span', { class: 'topbar__sep', attrs: { 'aria-hidden': 'true' } });
}

function dot(on: boolean | null, label: string, tip: string): HTMLElement {
  const cls = on === null ? 'is-unknown' : on ? 'is-on' : 'is-off';
  const mark = on === null ? '?' : on ? '●' : '×';
  return el(
    'span',
    { class: `status-dot ${cls}`, data: { tip }, tabIndex: 0 },
    el('span', { class: 'status-dot__mark', text: mark }),
    el('span', { class: 'status-dot__label', text: label }),
  );
}

export function activateCameraSettings(setTab: (id: string) => void, focusCamera: () => void): void {
  setTab('settings');
  focusCamera();
}

function cameraDot(ctx: Ctx): HTMLElement {
  const on = ctx.status.cameraOk;
  const cls = on === null ? 'is-unknown' : on ? 'is-on' : 'is-off';
  const mark = on === null ? '?' : on ? '●' : '×';
  const tip =
    on === null
      ? '중계 씬에 들어가면 카메라 상태가 확인됩니다. 눌러서 장치 연결 설정을 엽니다.'
      : on
        ? '출력 창에서 카메라가 열렸습니다. 눌러서 장치 연결 설정을 엽니다.'
        : '카메라를 열지 못했습니다. 눌러서 장치 연결 설정을 엽니다.';
  return el(
    'button',
    {
      class: `status-dot status-dot--action ${cls}`,
      type: 'button',
      data: { tip },
      attrs: { 'aria-label': `카메라 장비 연결 설정 열기, ${on === null ? '상태 확인 전' : on ? '연결됨' : '연결 실패'}` },
      on: {
        click: () =>
          activateCameraSettings(
            (id) => ctx.setTab(id),
            () => document.getElementById('cam-select')?.focus(),
          ),
      },
    },
    el('span', { class: 'status-dot__mark', text: mark }),
    el('span', { class: 'status-dot__label', text: '카메라' }),
  );
}

/**
 * 사진 자동 수집 경고 점 (계획 §10 위험 R1).
 *
 * **자동 수집이 켜져 있을 때만** 그린다. 꺼 두었다면 드롭·파일 선택으로만 넣겠다는
 * 운영자의 선택이고, 그 상태에 경고를 띄우면 상단 바가 상시 노란 화면이 된다.
 * 켜져 있는데 폴더 권한이 `granted`가 아니면 = **아무 사진도 안 들어오는데 아무 표시도
 * 없는** 상태다. 그 한 경우만 잡는다.
 *
 * 라벨은 상태와 무관하게 고정한다(출력 소리 점과 같은 이유 — 글자 길이가 바뀌면 옆
 * 요소가 밀려 상단 바가 흔들린다). 사유는 점의 색·형태와 툴팁이 알린다.
 */
function photoIntakeDot(ctx: Ctx): HTMLElement | null {
  if (!ctx.state.photos.settings.autoIntake) return null;
  const dir = ctx.status.photoDir ?? null;
  const tip =
    dir === null
      ? '폴더 상태를 아직 확인하지 않았습니다. 이 창이 조작 리더가 되면 확인합니다.'
      : dir === 'granted'
        ? '지정한 폴더를 주기적으로 훑어 새 사진을 자동으로 가져오고 있습니다.'
        : dir === 'prompt'
          ? '자동 수집이 켜져 있는데 폴더 권한이 풀렸습니다 — 브라우저를 재시작하면 원래 이렇게 됩니다. [현장 사진] 탭의 [폴더 다시 연결]을 한 번 누르면 복구됩니다. 그전까지 새 사진은 들어오지 않습니다.'
          : dir === 'denied'
            ? '자동 수집이 켜져 있는데 폴더 권한이 거부돼 있습니다. [현장 사진] 탭에서 폴더를 다시 선택하세요. 끌어다 놓기·파일 선택은 권한과 무관하게 됩니다.'
            : dir === 'none'
              ? '자동 수집이 켜져 있는데 수집할 폴더가 지정되지 않았습니다. [현장 사진] 탭에서 [폴더 선택]을 누르세요.'
              : '이 브라우저는 폴더 자동 수집을 지원하지 않습니다(Chrome에서만 됩니다). [현장 사진] 탭에 끌어다 놓거나 [파일 선택]을 쓰세요.';
  return dot(dir === null ? null : dir === 'granted', '사진 수집', tip);
}

/**
 * 한 축의 슬라이더 + 램프 버튼 두 개 (U45).
 *
 * 두 축이 **같은 컴포넌트**여야 한다 — 따로 쓰면 한쪽만 드래그 보류를 빠뜨리거나 한쪽 램프가
 * 다른 축 슬라이더를 끌고 가는 사고가 난다. 구분은 `data-axis` 하나이고,
 * 라이브 갱신(`paintVolumeReadout`)도 그 속성으로 범위를 좁힌다.
 */
function volumeAxisControl(ctx: Ctx, axis: VolumeAxis, now: number): HTMLElement {
  const s = ctx.state;
  // 램프가 도는 동안 상단 바가 보여 줄 값은 저장값이 아니라 **지금 들리는 값**이다.
  const heard = effectiveVolume(s.settings, s.volumeRamps, axis, now);
  const percent = volumePercent(heard);
  const rampTarget = s.volumeRamps[axis]?.to ?? null;
  const label = VOLUME_AXIS_LABEL[axis];

  return el(
    'div',
    { class: 'volume-axis', data: { axis } },
    el(
      'label',
      { class: 'volume-slider', data: { tip: VOLUME_AXIS_TIP[axis] } },
      el('span', { class: 'volume-slider__label mono-label', text: label }),
      el('input', {
        class: 'volume-slider__input',
        type: 'range',
        min: 0,
        max: 100,
        step: 1,
        value: percent,
        data: { fid: `volume-${axis}` },
        attrs: { 'aria-label': `${label} 출력 볼륨`, 'aria-valuetext': `${percent}%` },
        on: {
          // **드래그가 끊기던 실사고의 수정 지점** (U43).
          // 잡고 있는 동안 재렌더를 미룬다 — `render()`가 트리를 통째로 새로 만들기 때문에
          // 포인터를 붙잡고 있던 이 엘리먼트가 교체되면 암묵적 포인터 캡처가 떨어져 나간
          // 옛 노드에 남고, 드래그가 그 자리에서 멈춘다(클릭만 먹던 이유).
          pointerdown: () => {
            ctx.holdRender('volume', true);
            // 램프가 도는 중에 손을 대면 사용자가 이긴다 — 지금 들리는 값에서 끊는다.
            // 램프가 없으면 액션 자체를 내지 않는다(persist·방송이 헛돌지 않게).
            if (s.volumeRamps[axis]) ctx.dispatch({ type: 'volume/rampCancel', axis, now: Date.now() });
          },
          pointerup: () => ctx.holdRender('volume', false),
          pointercancel: () => ctx.holdRender('volume', false),
          // 캡처가 풀리는 모든 경로를 덮는다 — 창 밖에서 손을 떼면 pointerup이 오지 않는다.
          lostpointercapture: () => ctx.holdRender('volume', false),
          input: (ev) => {
            const value = Number((ev.target as HTMLInputElement).value);
            ctx.dispatch({ type: 'volume/set', axis, value: value / 100 });
            // 재렌더가 멈춰 있으므로 % 글자는 여기서 직접 따라가게 한다
            paintVolumeReadout(axis, value / 100);
          },
        },
      }),
      el('span', { class: 'volume-slider__value', text: `${percent}%` }),
    ),
    el(
      'div',
      { class: 'volume-ramp', attrs: { role: 'group', 'aria-label': `${label} 볼륨 램프` } },
      masterRampChoices().map((choice) => {
        const active = rampTarget !== null && Math.abs(rampTarget - choice.target) < 0.001;
        return el('button', {
          class: `volume-ramp__btn${active ? ' is-on' : ''}`,
          type: 'button',
          text: choice.label,
          attrs: {
            'aria-pressed': active ? 'true' : 'false',
            'aria-label': `${label} 볼륨을 ${volumePercent(choice.target)}퍼센트로 ${s.settings.masterRampSec}초에 걸쳐 옮기기`,
          },
          data: {
            fid: `volume-${axis}-ramp-${choice.id}`,
            tip: `${label} 볼륨을 ${volumePercent(choice.target)}%까지 ${s.settings.masterRampSec}초에 걸쳐 부드럽게 옮깁니다(뚝 끊기지 않습니다). 가는 도중 다른 버튼을 누르거나 슬라이더를 잡으면 그 자리에서 방향이 바뀝니다. 다른 축은 움직이지 않습니다. 길이는 [설정] → [마스터 램프]에서 바꿉니다.`,
          },
          on: {
            click: () =>
              ctx.dispatch({
                type: 'volume/rampTo',
                axis,
                target: choice.target,
                sec: s.settings.masterRampSec,
                now: Date.now(),
              }),
          },
        });
      }),
    ),
  );
}

/**
 * 출력 창 소리 잠김 대형 경고 (U48).
 *
 * 상단 바의 작은 상태 점 하나로는 부족했다 — 열 개 남짓한 다른 지표 사이에서 눈에 띄지 않는다.
 * 화면은 멀쩡히 나가고 소리만 없는 사고라, 알아채지 못하면 본방 첫 영상에서 발견한다.
 * 상시 빨강 배너로 띄우고, **지금 나가야 할 소리가 있으면** 한 단계 더 강조한다.
 *
 * 브라우저 정책은 변경하지 않는다. 출력 창을 한 번 클릭해 소리를 허용하도록
 * `AUDIO_LOCK_FIX`가 안내하며, 두 창은 동일한 브라우저 프로필을 사용한다.
 */
function audioLockBanner(ctx: Ctx): HTMLElement | null {
  const level = audioLockLevel(
    ctx.status.audioLocked,
    ctx.state.music.playing,
    videoAudioOwnsOutput(ctx.state),
  );
  if (level === 'none') return null;
  const message = audioLockMessage(level);
  return el(
    'div',
    {
      class: `audio-lock-banner${level === 'critical' ? ' is-critical' : ''}`,
      attrs: { role: 'alert' },
      data: { tip: message },
      tabIndex: 0,
    },
    el('span', { class: 'audio-lock-banner__mark', text: '🔇', attrs: { 'aria-hidden': 'true' } }),
    el(
      'span',
      { class: 'audio-lock-banner__body' },
      el('strong', { class: 'audio-lock-banner__title', text: AUDIO_LOCK_TITLE }),
      el('span', { class: 'audio-lock-banner__hint', text: message }),
    ),
  );
}

/**
 * 상단 미니 플레이어 (U49).
 *
 * 음악 조작은 [음악] 탭 안에만 있었다. 그런데 곡을 멈추거나 다음으로 넘기는 일은 **다른 탭에서
 * 일하는 도중에** 생긴다(점수 입력 중 노래가 튀는 등). 탭을 옮겼다 돌아오는 사이가 방송에
 * 그대로 나가므로, 가장 자주 쓰는 여섯 개만 상단에 상시로 둔다.
 *
 * 곡을 **고르는** 일은 여기 두지 않는다 — 목록은 [음악] 탭이 답이고, 상단 바에 넣으면
 * 폭을 감당할 수 없다. 곡 이름은 nowrap + 말줄임이라 길어져도 상단 바가 흔들리지 않는다.
 */
function musicMiniPlayer(ctx: Ctx): HTMLElement | null {
  const m = ctx.state.music;
  const current = musicTrack(m.trackId);
  if (!current) return null;

  const mode = ctx.state.settings.musicRepeat;
  const bookmark = bookmarkOf(m.bookmarks, m.trackId);

  return el(
    'div',
    { class: 'miniplayer', attrs: { role: 'group', 'aria-label': '행사 음악 미니 플레이어' } },
    el(
      'div',
      {
        class: 'miniplayer__now',
        data: {
          tip: `${current.label} — 지금 상단에서 조작할 수 있는 것은 재생·정지·앞뒤 곡·북마크부터·이어재생 모드입니다. 곡 고르기와 스크럽은 [음악] 탭에 있습니다.`,
        },
        tabIndex: 0,
      },
      el('span', { class: `miniplayer__dot${m.playing ? ' is-on' : ''}`, attrs: { 'aria-hidden': 'true' }, text: m.playing ? '●' : '■' }),
      el('span', { class: 'miniplayer__title', text: current.label }),
      el(
        'span',
        { class: 'miniplayer__time mono-label' },
        el('span', { data: { live: 'music-time' }, text: formatMusicTime(m.positionSec) }),
        el('span', { text: ' / ' }),
        el('span', { data: { live: 'music-duration' }, text: formatMusicTime(current.durationSec) }),
      ),
    ),
    el(
      'div',
      { class: 'miniplayer__transport' },
      miniBtn('⏮', '이전 곡', () => {
        const id = stepTrackId(m.trackId, -1);
        if (id) ctx.dispatch({ type: 'music/play', trackId: id, now: Date.now() });
      }, '전체 목록에서 이전 곡으로 넘어갑니다(이어재생 모드와 무관합니다). 목록 처음에서는 마지막 곡으로 감깁니다.'),
      miniBtn(m.playing ? '⏸' : '▶', m.playing ? '일시정지' : '재생', () => {
        // 위치는 **지금 울리는 값**이어야 한다 (리뷰). `m.positionSec`은 마지막 명령 위치라,
        // 재생 중 한참 지난 뒤 여기서 멈추면 곡이 그 옛 자리로 되감긴다.
        // 음악 탭의 [일시정지]와 같은 `livePosition()`을 쓴다 — 두 버튼이 다른 자리를 찍으면 안 된다.
        ctx.dispatch(
          m.playing
            ? { type: 'music/pause', positionSec: livePosition(ctx).t }
            : { type: 'music/resume' },
        );
      }, '행사 BGM을 재생하거나 일시정지합니다. 설정한 음악 페이드 길이에 맞춰 오르내립니다.'),
      miniBtn('⏹', '정지', () => ctx.dispatch({ type: 'music/stop', now: Date.now() }),
        '곡을 내려놓습니다. 다시 틀려면 [음악] 탭에서 고르거나 여기 ⏭/⏮로 넘어갑니다.'),
      miniBtn('⏭', '다음 곡', () => {
        const id = stepTrackId(m.trackId, 1);
        if (id) ctx.dispatch({ type: 'music/play', trackId: id, now: Date.now() });
      }, '전체 목록에서 다음 곡으로 넘어갑니다(이어재생 모드와 무관합니다). 목록 끝에서는 첫 곡으로 감깁니다.'),
      bookmark !== null
        ? miniBtn('⌖', `북마크 ${formatMusicTime(bookmark)}부터 재생`, () => {
            ctx.dispatch({ type: 'music/play', trackId: current.id, startSec: bookmark, now: Date.now() });
          }, `이 곡의 북마크(${formatMusicTime(bookmark)})부터 다시 재생합니다. 북마크는 재생 중 B 키로 찍습니다.`)
        : null,
    ),
    el('button', {
      class: 'miniplayer__mode mono-label',
      type: 'button',
      text: MUSIC_REPEAT_MARK[mode],
      attrs: { 'aria-label': `이어재생 모드: ${MUSIC_REPEAT_TIP[mode]} 눌러서 다음 모드로` },
      data: { fid: 'music-repeat', tip: `이어재생 — ${MUSIC_REPEAT_TIP[mode]} 눌러서 없음 → 한 곡 → 구간 → 전체 순으로 바꿉니다. 바꿔도 지금 곡은 그대로이고 다음 곡부터 적용됩니다.` },
      on: {
        click: () => {
          const at = MUSIC_REPEAT_MODES.indexOf(mode);
          const next = MUSIC_REPEAT_MODES[(at + 1) % MUSIC_REPEAT_MODES.length];
          ctx.dispatch({ type: 'settings/patch', patch: { musicRepeat: next } });
        },
      },
    }),
  );
}

function miniBtn(
  mark: string,
  label: string,
  onClick: () => void,
  tip: string,
): HTMLElement {
  return el('button', {
    class: 'miniplayer__btn',
    type: 'button',
    text: mark,
    attrs: { 'aria-label': label },
    data: { tip },
    on: { click: onClick },
  });
}

/**
 * PGM FREEZE 묶음 (U75) — 상단 바에서 **시각적으로 떨어져** 있다.
 *
 * 씬 이름 바로 옆에 두되 세로 구분선과 여백으로 갈라 놓는다. 다른 상단 조작(볼륨·음악)과
 * 붙어 있으면 볼륨을 만지다 화면을 얼리는 오조작이 나온다. 같은 이유로 단축키도 없다 —
 * F1~F10·Space·B·R이 이미 손에 붙어 있어 새 키를 더하면 오조작 거리가 0이 된다.
 */
function freezeGroup(ctx: Ctx): HTMLElement {
  const frozen = ctx.state.pgm.frozen;
  const view = freezeToggleView(frozen);
  return el(
    'div',
    { class: `topbar__freeze${frozen ? ' is-on' : ''}` },
    el('button', {
      class: `freeze-btn${frozen ? ' is-on' : ''}`,
      type: 'button',
      text: view.label,
      attrs: { 'aria-pressed': view.pressed ? 'true' : 'false' },
      data: { fid: 'pgm-freeze', tip: view.tip },
      on: { click: () => ctx.dispatch({ type: 'pgm/freeze', on: !frozen }) },
    }),
    // 버튼 라벨만으로도 상태를 알 수 있지만, 배지는 **탭을 아무 데나 열어 두고 있어도**
    // 눈에 띄는 두 번째 신호다. 움직이는 것은 opacity 하나뿐(레이아웃·색은 고정).
    frozen
      ? el('span', {
          class: 'freeze-badge',
          text: 'FROZEN',
          data: { tip: '출력 화면이 지금 그림에 고정되어 있습니다. 씬·오버레이를 바꿔도 화면에는 나가지 않습니다.' },
          tabIndex: 0,
        })
      : null,
  );
}

export function renderTopbar(ctx: Ctx): HTMLElement {
  const s = ctx.state;
  const effective = pickScene(s);
  const degraded = isDegraded(s);
  const now = Date.now();
  const remaining = remainingSec(s.timer, now);
  // 퓨어 카메라(U131)로 나가는 동안은 상단 바도 그 사실을 말한다 — 오퍼레이터가 [경기 중계]
  // 라벨만 보고 크롬이 떠 있다고 오해하면 안 된다.
  const sceneName =
    effective === 'live' && isPureCameraOverlay(s.sceneOpts.liveOverlay)
      ? `${SCENE_LABELS[effective]} · 퓨어`
      : SCENE_LABELS[effective];

  return el(
    'header',
    { class: 'topbar' },
    /**
     * U115 — 2행 구조. 1행은 "지금 무엇이 나가는가"(씬·FREEZE·타이머·상태),
     * 2행은 "지금 무엇이 들리는가"(미니 플레이어·MEDIA·MUSIC 볼륨). 창이 좁아
     * 한 줄에 다 안 들어가도 `.topbar__row`의 wrap이 다음 줄로 흘려보낼 뿐,
     * 요소끼리 겹치지 않는다 — 원인·근거는 각 CSS 규칙 주석 참고.
     */
    el(
      'div',
      { class: 'topbar__row topbar__row--1' },
      // 출력 화면과 같은 마크를 패널 헤더에도 둔다 (같은 행사라는 신호).
      // 출력 화면과 같은 중립 모노그램을 사용한다.
      el(
        'span',
        { class: 'topbar__emblem' },
        el('img', {
          class: 'topbar__mark',
          src: EVENT_MARK_SRC,
          alt: '',
          attrs: { 'aria-hidden': 'true' },
        }),
      ),
      el(
        'div',
        { class: 'topbar__scene' },
        el('span', { class: 'topbar__scene-eyebrow mono-label', text: 'ON AIR' }),
        el('span', { class: 'topbar__scene-name', text: sceneName }),
        degraded
          ? el('span', {
              class: 'chip chip--warn',
              text: '잠금으로 대기 화면 대체됨',
              data: { tip: '선택된 씬이 잠긴 묶음에 속해 출력에는 대기 화면이 나갑니다.' },
              tabIndex: 0,
            })
          : null,
      ),
      sep(),
      freezeGroup(ctx),
      sep(),
      el('span', { class: `chip chip--phase`, text: PHASE_LABEL[s.phase] ?? s.phase }),
      /**
       * 되감기가 도는 동안 상단에 상시 노출한다 (Q5). 출력에 나가는 그림이 지금 라이브가
       * 아니라는 사실을 조작 화면 어디에 있든 알아야 한다 — 오디오 잠김 칩과 같은 이유·같은 자리.
       */
      s.sceneOpts.liveOverlay.replay
        ? el('span', {
            class: 'chip chip--replay',
            text: `REPLAY ×${formatReplayRate(s.sceneOpts.liveOverlay.replay.rate)}`,
            data: {
              tip: `출력 화면이 지금 라이브가 아니라 되감기입니다. 마지막 ${s.sceneOpts.liveOverlay.replay.seconds}초를 ${formatReplayRate(s.sceneOpts.liveOverlay.replay.rate)}배속으로 틀고 있습니다. 끝나면 저절로 라이브로 돌아오고, R 또는 씬 런처의 [라이브 복귀]로 바로 끊을 수 있습니다.`,
            },
            tabIndex: 0,
          })
        : null,
      ctx.status.saveError
        ? el('span', {
            class: 'chip chip--warn',
            text: '저장 실패',
            data: { tip: ctx.status.saveError },
            tabIndex: 0,
          })
        : null,
      // 출력 창에서 운영자가 음소거를 눌렀다 (U88). 잠김 배너와 **같은 톤·다른 자리**다 —
      // 저쪽은 고쳐야 할 사고라 배너로 크게, 이쪽은 운영자가 스스로 누른 상태라 칩으로 조용히.
      userMuteChipVisible(ctx.status.displayUserMuted)
        ? el('span', {
            class: 'chip chip--warn',
            text: USER_MUTE_CHIP,
            data: { tip: USER_MUTE_CHIP_TIP },
            tabIndex: 0,
          })
        : null,
      sep(),
      el(
        'div',
        { class: 'topbar__timer', data: { tip: `프리셋 ${s.timer.durationSec}초 · ${isRunning(s.timer) ? '구동 중' : '정지'}` }, tabIndex: 0 },
        el('span', { class: `topbar__timer-time${remaining <= 10 && isRunning(s.timer) ? ' is-danger' : ''}`, text: formatMMSS(remaining) }),
        el('span', { class: 'topbar__timer-state', text: isRunning(s.timer) ? '구동' : '정지' }),
      ),
      audioLockBanner(ctx),
      el('div', { class: 'topbar__spacer' }),
      el(
        'div',
        { class: 'topbar__status' },
        dot(
          ctx.status.saveError ? false : true,
          ctx.status.saveError ? '저장 실패' : '저장됨',
          ctx.status.saveError
            ? ctx.status.saveError
            : `마지막 저장 ${new Date(ctx.status.savedAt || now).toLocaleTimeString('ko-KR', { hour12: false })} · 모든 변경을 150ms 안에 localStorage에 쓰고 5초마다 IndexedDB 스냅샷을 남깁니다. 영상·로고는 IndexedDB에 따로 보관합니다.`,
        ),
        dot(ctx.status.displayConnected, '출력창', ctx.status.displayConnected ? '출력 창이 연결되어 상태를 받고 있습니다.' : '출력 창이 열려 있지 않습니다. [출력창 열기]를 누르세요.'),
        cameraDot(ctx),
        // 브라우저 정책상 출력 창에 사용자 제스처가 한 번 필요하다. 출력 창은 원래 손대지 않는
        // 창이라 리허설에서 놓치기 쉬워, 카메라 점과 같은 컴포넌트·같은 주기로 상시 노출한다.
        dot(
          ctx.status.audioLocked == null ? null : !ctx.status.audioLocked,
          // 라벨은 고정한다 — 글자가 길어졌다 짧아졌다 하면 옆 요소가 밀려 상단 바가 흔들리고,
          // 눈이 "무엇이 바뀌었나"를 라벨에서 찾게 된다. 잠김 여부는 점의 색(is-on/is-off)과
          // 형태(● / ×), 그리고 툴팁이 알린다.
          '출력 소리',
          ctx.status.audioLocked == null
            ? '출력 창이 아직 오디오 상태를 알려 주지 않았습니다.'
            : ctx.status.audioLocked
              ? '출력 오디오 잠김 — 출력 창을 한 번 클릭하세요. 브라우저 자동재생 정책 때문에 출력 창에 사용자 제스처가 한 번 있어야 설명 영상 소리가 나갑니다. 클릭하지 않아도 화면은 정상이고 영상만 무음으로 나갑니다.'
              : '출력 창에서 소리가 나갑니다.',
        ),
        photoIntakeDot(ctx),
      ),
      el('button', {
        class: 'btn btn--ghost',
        type: 'button',
        text: '출력창 열기',
        data: { tip: AUDIO_LOCK_OPEN_DISPLAY_TIP },
        on: { click: () => window.open('./display.html', 'event-console-display', 'width=1280,height=720') },
      }),
    ),
    el(
      'div',
      { class: 'topbar__row topbar__row--2' },
      musicMiniPlayer(ctx),
      VOLUME_AXES.map((axis) => volumeAxisControl(ctx, axis, now)),
    ),
  );
}
