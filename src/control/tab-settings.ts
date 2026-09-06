import { clearAll, listSnapshots } from '../db';
import { SCENE_LABELS } from '../scenes';
import {
  AUDIO_CUT_FADE_SEC_RANGE,
  BLACKOUT_SEC_RANGE,
  LAUNCHER_EXTRA_SCENES,
  MAX_FADE_SETTING_SEC,
  MOOD_BLACKOUT_SEC_RANGE,
  MOOD_TOTAL_SEC_RANGE,
  REPLAY_RATES,
  REPLAY_SEC_RANGE,
  activeTeamIds,
  createInitialState,
  deserialize,
  normalizeRangedSetting,
  serialize,
} from '../state';
import { MASTER_RAMP_SEC_RANGE } from '../volume-ramp';
import { MUSIC_DUCK_SEC_RANGE } from '../music-duck';
import { formatReplayRate } from '../replay-ring';
import { MUSIC_REPEAT_LABEL, MUSIC_REPEAT_MODES, MUSIC_REPEAT_TIP } from '../music-autoplay';
import { MUSIC_TRACKS, musicTrack } from '../music';
import { bookmarkOf, type MusicBookmarks } from '../music-bookmarks';
import { el } from './dom';
import { isMediaAsset } from '../media-manifest';
import { openModal } from './modal';
import { toast } from './toast';
import type { Ctx } from './ctx';
import type { LauncherExtraSceneId, Settings } from '../types';

export const meta = { id: 'settings', label: '설정' };

/** 카메라 장치 목록은 비동기라 모듈 캐시에 담아 두고 준비되면 패널을 다시 그린다 */
let deviceCache: MediaDeviceInfo[] = [];
let deviceLoaded = false;

export async function loadDevices(ctx: Ctx, askPermission = false): Promise<void> {
  try {
    if (askPermission && navigator.mediaDevices?.getUserMedia) {
      // 장치 "이름"은 권한이 있어야 보인다. 확인 즉시 트랙을 닫는다.
      const tmp = await navigator.mediaDevices.getUserMedia({ video: true });
      tmp.getTracks().forEach((t) => t.stop());
    }
    const list = await navigator.mediaDevices.enumerateDevices();
    deviceCache = list.filter((d) => d.kind === 'videoinput');
    deviceLoaded = true;
    ctx.refresh();
  } catch {
    deviceLoaded = true;
    ctx.refresh();
  }
}

function download(name: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const HOTKEYS: [string, string][] = [
  ['F1', '대기 화면'],
  ['F2', '경기 중계'],
  ['F3', '스코어보드'],
  ['F4', '풀스크린 타이머'],
  ['F6', '현장 사진'],
  ['F9', '긴급 속보 (잠금 해제 후)'],
  ['F10', '보드 (잠금 해제 후)'],
  ['Space', '타이머 시작 / 일시정지'],
  ['← →', '큐시트 이전 / 다음'],
  ['B', '지금 재생 위치를 음악 북마크로'],
  ['R', '슬로우 리플레이 시작 / 라이브 복귀 (중계 화면)'],
  ['Shift+R', '[지금부터] 구간 찍기 / 여기까지 되감기 (중계 화면)'],
  ['Cmd+,', '설정 탭 열기'],
  ['Cmd+= / Cmd+-', '출력창 GUI 5% 확대 / 축소'],
  ['Esc', '모달 닫기'],
];

/** 설정에서 숫자로 조절하는 페이드·반전 필드 키 */
type FadeSettingKey =
  | 'blackoutSec'
  | 'musicFadeSec'
  | 'backdropCrossfadeSec'
  | 'moodTotalSec'
  | 'moodBlackoutSec'
  | 'moodGlitchStrength'
  | 'audioCutFadeSec'
  | 'masterRampSec'
  | 'musicDuckSec'
  | 'replaySec';

/** 계산된 키로 만든 객체는 `Partial<Settings>`로 좁혀지지 않는다 — 캐스트 대신 여기서 분기한다. */
function fadeSettingPatch(key: FadeSettingKey, value: number): Partial<Settings> {
  switch (key) {
    case 'blackoutSec':
      return { blackoutSec: value };
    case 'musicFadeSec':
      return { musicFadeSec: value };
    case 'backdropCrossfadeSec':
      return { backdropCrossfadeSec: value };
    case 'moodTotalSec':
      return { moodTotalSec: value };
    case 'moodBlackoutSec':
      return { moodBlackoutSec: value };
    case 'audioCutFadeSec':
      return { audioCutFadeSec: value };
    case 'masterRampSec':
      return { masterRampSec: value };
    case 'musicDuckSec':
      return { musicDuckSec: value };
    case 'replaySec':
      // 세그먼트 주기(=2배)의 입력이라 정수 초로만 저장한다
      return { replaySec: Math.round(value) };
    default:
      return { moodGlitchStrength: value };
  }
}

/**
 * 초 단위 페이드 길이 입력 한 줄 (음악 페이드 · 사진 배경 크로스).
 *
 * 두 줄이 같은 폭·같은 클램프(0~60초)·같은 tooltip 관례를 쓰도록 한 곳에서 만든다.
 * 라벨은 hover와 키보드 포커스 양쪽에서 같은 상세를 연다(`data-tip` + `tabIndex=0`).
 * 숫자 입력 중 전역 단축키는 hotkeys.ts가 입력 필드에서 개입하지 않으므로 그대로 안전하다.
 */
function fadeSecField(
  ctx: Ctx,
  opts: {
    id: string;
    label: string;
    key: FadeSettingKey;
    tip: string;
    /** 기본은 0~60초 · 0.5 단위. 반전 단계처럼 범위가 다르면 넘긴다 */
    range?: { min: number; max: number; step: number; unit: string };
  },
): HTMLElement {
  const fallback = createInitialState().settings[opts.key];
  const range = opts.range ?? { min: 0, max: MAX_FADE_SETTING_SEC, step: 0.5, unit: '초' };
  return el(
    'div',
    { class: 'field field--narrow' },
    el('label', {
      class: 'field__label',
      text: opts.label,
      attrs: { for: opts.id },
      data: { tip: opts.tip },
      tabIndex: 0,
    }),
    el('input', {
      class: 'input input--num',
      id: opts.id,
      type: 'number',
      min: range.min,
      max: range.max,
      step: range.step,
      value: ctx.state.settings[opts.key],
      data: { fid: opts.id },
      on: {
        change: (ev) => {
          const raw = Number((ev.target as HTMLInputElement).value);
          const next = normalizeRangedSetting(raw, fallback, range);
          ctx.dispatch({ type: 'settings/patch', patch: fadeSettingPatch(opts.key, next) });
        },
      },
    }),
    el('span', { class: 'field__unit', text: range.unit }),
  );
}

/**
 * 승리 음악 줄 아래에 붙는 안내 (U110).
 *
 * 곡을 골랐는지, 북마크가 있어 어디부터 나가는지를 한 줄로 말한다 — 이 두 값이 실제
 * 재생을 정하는데(`victoryMusicOf`), 드롭다운만으로는 시작 지점이 보이지 않는다.
 */
export function victoryMusicHint(trackId: string | null, bookmarks: MusicBookmarks): string {
  if (!trackId) {
    return '승리 음악을 고르지 않으면 승리 발표에 영상만 나갑니다. 곡을 정해 파일이 들어오면 음악 라이브러리에 넣고 여기서 고르세요.';
  }
  const track = musicTrack(trackId);
  if (!track) return '고른 곡이 지금 음악 라이브러리에 없습니다 — 다시 고르세요.';
  const start = bookmarkOf(bookmarks, trackId);
  return start === null
    ? `승리 발표에 '${track.label}'이(가) 처음부터 재생됩니다. [음악] 탭에서 북마크를 찍으면 그 지점부터 나갑니다.`
    : `승리 발표에 '${track.label}'이(가) ${Math.round(start)}초 지점(북마크)부터 재생됩니다.`;
}

export function render(ctx: Ctx): HTMLElement {
  const s = ctx.state;
  if (!deviceLoaded) void loadDevices(ctx, false);

  const teamCount = activeTeamIds(s).length;
  // 속보 체인에 물릴 후보 — media 폴더 항목이 앞에 오게 해서 기본값으로 고르기 쉽게 둔다
  const videoAssets = s.assets
    .filter((a) => a.type === 'video')
    .sort((a, b) => Number(isMediaAsset(b.id)) - Number(isMediaAsset(a.id)) || (a.order ?? 0) - (b.order ?? 0));
  const breakVideoId = s.sceneOpts.video.assetId;

  const numRow = (label: string, values: number[], onChange: (i: number, v: number) => void, tip: string) =>
    el(
      'div',
      { class: 'field' },
      el('label', { class: 'field__label', text: label, data: { tip }, tabIndex: 0 }),
      el(
        'div',
        { class: 'numrow' },
        // 팀 수만큼만 보여 준다 — 4팀 행사에서 5·6위 칸은 의미가 없다
        values.slice(0, teamCount).map((v, i) =>
          el(
            'span',
            { class: 'numrow__cell' },
            el('span', { class: 'numrow__rank mono-label', text: `${i + 1}위` }),
            el('input', {
              class: 'input input--num',
              type: 'number',
              value: v,
              data: { fid: `${label}-${i}` },
              on: { change: (ev) => onChange(i, Number((ev.target as HTMLInputElement).value) || 0) },
            }),
          ),
        ),
      ),
    );

  return el(
    'div',
    { class: 'tabpane' },

    el('h3', { class: 'section__title', text: '참가 팀' }),
    el(
      'div',
      { class: 'field' },
      el('span', {
        class: 'chip chip--gold',
        text: `${teamCount}팀 확정`,
        data: { tip: '행사 운영 기준이 4팀으로 확정되어 점수 입력·스코어보드·시상 모두 4팀만 사용합니다.' },
        tabIndex: 0,
      }),
    ),

    el('h3', { class: 'section__title', text: '점수표' }),
    s.settings.scoreTableProvisional
      ? el(
          'div',
          { class: 'field' },
          el('span', {
            class: 'chip chip--warn',
            text: '임시값 (HUMAN 확인 필요)',
            data: {
              tip: '진행 대본에는 4위까지만 배점이 있습니다. 5·6위 값은 앱이 임시로 정한 것이니 확인 후 확정하세요.',
            },
            tabIndex: 0,
          }),
          el('button', {
            class: 'btn btn--tiny',
            type: 'button',
            text: '확인함 — 이 배점으로 갑니다',
            on: {
              click: () => {
                ctx.dispatch({ type: 'settings/patch', patch: { scoreTableProvisional: false } });
                toast('점수표를 확정했습니다');
              },
            },
          }),
        )
      : null,
    numRow(
      '1부 점수',
      s.settings.scoreTable.p1,
      (i, v) => {
        const next = [...s.settings.scoreTable.p1];
        next[i] = v;
        ctx.dispatch({ type: 'settings/patch', patch: { scoreTable: { p1: next } } });
      },
      '순위별 배점. 공동 순위는 해당 슬롯들의 평균을 나눠 갖습니다.',
    ),
    numRow(
      '2부 점수',
      s.settings.scoreTable.p2,
      (i, v) => {
        const next = [...s.settings.scoreTable.p2];
        next[i] = v;
        ctx.dispatch({ type: 'settings/patch', patch: { scoreTable: { p2: next } } });
      },
      '순위별 배점. 3위·5위·6위 값은 현장 확인 후 조정 가능합니다.',
    ),
    el(
      'div',
      { class: 'field field--narrow' },
      el('label', {
        class: 'field__label',
        text: '동시 제출 임계 (초)',
        attrs: { for: 'tie-window' },
        data: { tip: '선두 제출로부터 이 시간 안에 들어온 제출은 공동 순위로 묶여 점수를 평균 배분합니다.' },
        tabIndex: 0,
      }),
      el('input', {
        class: 'input input--num',
        id: 'tie-window',
        type: 'number',
        min: 0,
        max: 60,
        value: s.settings.tieWindowSec,
        data: { fid: 'tie-window' },
        on: {
          change: (ev) =>
            ctx.dispatch({
              type: 'settings/patch',
              patch: { tieWindowSec: Math.max(0, Number((ev.target as HTMLInputElement).value) || 0) },
            }),
        },
      }),
    ),

    el('h3', { class: 'section__title', text: '대기 화면 문구' }),
    el(
      'div',
      { class: 'field' },
      el('label', { class: 'field__label', text: '타이틀', attrs: { for: 'kv-title' } }),
      el('input', {
        class: 'input',
        id: 'kv-title',
        type: 'text',
        value: s.settings.title,
        data: { fid: 'kv-title' },
        on: {
          change: (ev) =>
            ctx.dispatch({ type: 'settings/patch', patch: { title: (ev.target as HTMLInputElement).value } }),
        },
      }),
    ),
    el(
      'div',
      { class: 'field' },
      el('label', { class: 'field__label', text: '부제', attrs: { for: 'kv-sub' } }),
      el('input', {
        class: 'input',
        id: 'kv-sub',
        type: 'text',
        value: s.settings.subtitle,
        data: { fid: 'kv-sub' },
        on: {
          change: (ev) =>
            ctx.dispatch({ type: 'settings/patch', patch: { subtitle: (ev.target as HTMLInputElement).value } }),
        },
      }),
    ),

    el('h3', { class: 'section__title', text: '속보 연결 영상' }),
    el(
      'div',
      { class: 'field' },
      el('label', {
        class: 'field__label',
        text: '스팅 다음 영상',
        attrs: { for: 'break-video' },
        data: {
          tip: 'F9(긴급 속보)를 누르면 스팅이 지나간 뒤 이 영상이 재생되고, 끝나면 보드로 넘어갑니다. 지정하지 않으면 영상 없이 보드로 바로 넘어갑니다.',
        },
        tabIndex: 0,
      }),
      el(
        'select',
        {
          class: 'input input--select',
          id: 'break-video',
          data: { fid: 'break-video' },
          on: {
            change: (ev) => {
              const v = (ev.target as HTMLSelectElement).value;
              ctx.dispatch({
                type: 'sceneOpts/patch',
                patch: { video: { assetId: v || null, nextScene: v ? 'suspects' : null } },
              });
              toast(v ? '속보 연결 영상을 지정했습니다' : '속보 연결 영상을 비웠습니다', v ? 'ok' : 'warn');
            },
          },
        },
        el('option', {
          value: '',
          text: '지정 안 함 (스팅 → 보드)',
          attrs: { selected: breakVideoId ? undefined : 'selected' },
        }),
        videoAssets.map((a) =>
          el('option', {
            value: a.id,
            // media 폴더 항목은 어느 PC에서 열어도 들어오므로 기본값으로 삼기 좋다 — 목록에서 구분해 준다
            text: isMediaAsset(a.id) ? `📁 ${a.name} (media 폴더)` : a.name,
            attrs: { selected: breakVideoId === a.id ? 'selected' : undefined },
          }),
        ),
      ),
    ),
    videoAssets.length
      ? null
      : el('p', {
          class: 'tabpane__hint',
          text: '등록된 영상이 없습니다. [영상·에셋] 탭에서 파일을 넣거나 media 폴더에 mp4를 두세요.',
        }),

    /**
     * 승리 음악 (U110, 04:56 사용자 지시: "내가 준 영상과 음악으로 대체하고").
     *
     * 파일 슬롯이 아니라 **음악 라이브러리 곡 선택**이다 — 승리 음악도 결국 행사 BGM 덱에서
     * 나가야 볼륨·북마크·이어재생이 그대로 걸린다. 별도 슬롯을 만들면 덱 밖에 소리가 하나
     * 더 생긴다. 지시 시점에 곡이 아직 정해지지 않아 기본은 [지정 안 함]이다.
     */
    el('h3', { class: 'section__title', text: '승리 음악' }),
    el(
      'div',
      { class: 'field' },
      el('label', {
        class: 'field__label',
        text: '승리 발표 곡',
        attrs: { for: 'victory-music' },
        data: {
          tip: '1부 종목 승리 발표(큐시트 · [1부 컨트롤] 탭 [송출])에서 승리 영상과 함께 이 곡이 재생됩니다. 그 곡에 북마크(U47)를 찍어 두었으면 그 지점부터 나갑니다. 지정하지 않으면 영상만 나갑니다. 승리 영상은 무음이라 이 음악이 그대로 들립니다(자동 덕킹 대상 아님).',
        },
        tabIndex: 0,
      }),
      el(
        'select',
        {
          class: 'input input--select',
          id: 'victory-music',
          data: { fid: 'victory-music' },
          on: {
            change: (ev) => {
              const v = (ev.target as HTMLSelectElement).value;
              ctx.dispatch({ type: 'settings/patch', patch: { victoryMusicTrackId: v || null } });
              toast(
                v ? `승리 음악: ${musicTrack(v)?.label ?? v}` : '승리 음악을 비웠습니다 — 영상만 나갑니다',
                v ? 'ok' : 'warn',
              );
            },
          },
        },
        el('option', {
          value: '',
          text: '지정 안 함 (영상만)',
          attrs: { selected: s.settings.victoryMusicTrackId ? undefined : 'selected' },
        }),
        MUSIC_TRACKS.map((track) =>
          el('option', {
            value: track.id,
            // 업로드한 곡이 많아도 구분할 수 있게 [음악] 탭과 같은 섹션 표기를 쓴다.
            text: `${track.section} · ${track.label}`,
            attrs: {
              selected: s.settings.victoryMusicTrackId === track.id ? 'selected' : undefined,
            },
          }),
        ),
      ),
    ),
    el('p', {
      class: 'tabpane__hint',
      text: victoryMusicHint(s.settings.victoryMusicTrackId, s.music.bookmarks),
    }),

    el('h3', { class: 'section__title', text: '카메라' }),
    el(
      'div',
      { class: 'field' },
      el('label', { class: 'field__label', text: '중계 카메라', attrs: { for: 'cam-select' } }),
      el(
        'select',
        {
          class: 'input input--select',
          id: 'cam-select',
          data: { fid: 'cam-select' },
          on: {
            change: (ev) => {
              const v = (ev.target as HTMLSelectElement).value;
              ctx.dispatch({ type: 'settings/patch', patch: { camera: { deviceId: v || null } } });
            },
          },
        },
        el('option', {
          value: '',
          text: '기본 카메라',
          attrs: { selected: s.settings.camera.deviceId ? undefined : 'selected' },
        }),
        deviceCache.map((d, i) =>
          el('option', {
            value: d.deviceId,
            text: d.label || `카메라 ${i + 1}`,
            attrs: { selected: s.settings.camera.deviceId === d.deviceId ? 'selected' : undefined },
          }),
        ),
      ),
      el('button', {
        class: 'btn btn--tiny',
        type: 'button',
        text: '장치 목록 새로고침',
        data: { tip: '장치 이름을 보려면 카메라 권한이 필요합니다. 누르면 권한을 요청합니다.' },
        on: { click: () => void loadDevices(ctx, true) },
      }),
    ),
    el(
      'div',
      { class: 'btnrow' },
      el('button', {
        class: `seg__btn${s.settings.camera.flipX ? ' is-on' : ''}`,
        type: 'button',
        text: `${s.settings.camera.flipX ? '☑' : '☐'} 좌우 반전`,
        attrs: { 'aria-pressed': s.settings.camera.flipX ? 'true' : 'false' },
        on: {
          click: () =>
            ctx.dispatch({
              type: 'settings/patch',
              patch: { camera: { flipX: !s.settings.camera.flipX } },
            }),
        },
      }),
      el('button', {
        class: `seg__btn${s.settings.camera.flipY ? ' is-on' : ''}`,
        type: 'button',
        text: `${s.settings.camera.flipY ? '☑' : '☐'} 상하 반전`,
        attrs: { 'aria-pressed': s.settings.camera.flipY ? 'true' : 'false' },
        on: {
          click: () =>
            ctx.dispatch({
              type: 'settings/patch',
              patch: { camera: { flipY: !s.settings.camera.flipY } },
            }),
        },
      }),
      // 기본 off — 켜면 오디오 트랙까지 요청한다. 끈 상태에서는 권한 프롬프트도 뜨지 않는다.
      el('button', {
        class: `seg__btn${s.settings.camera.audio ? ' is-on' : ''}`,
        type: 'button',
        text: `${s.settings.camera.audio ? '☑ 중계 카메라 소리 켬' : '☐ 중계 카메라 소리 끔'}`,
        attrs: { 'aria-pressed': s.settings.camera.audio ? 'true' : 'false' },
        data: {
          fid: 'cam-audio',
          tip: '같은 방의 스피커 소리가 카메라 마이크로 되돌아가 하울링이 납니다. 출력 PC와 스피커가 물리적으로 분리된 경우에만 켜세요.',
        },
        on: {
          click: () =>
            ctx.dispatch({
              type: 'settings/patch',
              patch: { camera: { audio: !s.settings.camera.audio } },
            }),
        },
      }),
    ),
    el('p', {
      class: 'tabpane__hint',
      text: '카메라는 출력 창에서 열립니다. 출력 창을 처음 열 때 브라우저 권한 팝업을 허용하세요. 권한이 없거나 장치가 없으면 컬러바와 NO SIGNAL이 나갑니다.',
    }),

    el('h3', { class: 'section__title', text: '페이드' }),
    el(
      'div',
      { class: 'field field--narrow' },
      el('label', {
        class: 'field__label',
        text: '영상 페이드',
        attrs: { for: 'fade-sec' },
        data: {
          tip: '설명 영상 앞뒤로 화면과 소리를 함께 검정으로 넘깁니다. 0이면 컷으로 바로 전환합니다. 씬 교체는 검정이 화면을 완전히 덮은 뒤에만 일어나므로, 이 값을 늘리면 영상이 시작되기까지 그만큼 더 걸립니다.',
        },
        tabIndex: 0,
      }),
      el('input', {
        class: 'input input--num',
        id: 'fade-sec',
        type: 'number',
        min: 0,
        max: 3,
        step: 0.05,
        value: s.settings.fadeSec,
        data: { fid: 'fade-sec' },
        on: {
          change: (ev) => {
            const raw = Number((ev.target as HTMLInputElement).value);
            const fadeSec = Number.isFinite(raw) ? Math.max(0, Math.min(3, raw)) : 0.5;
            ctx.dispatch({ type: 'settings/patch', patch: { fadeSec } });
          },
        },
      }),
      el('span', { class: 'field__unit', text: '초' }),
    ),
    el('p', {
      class: 'tabpane__hint',
      text: '전환 오버레이("대판")는 이 값과 무관합니다 — 대판은 알파 스팅어라 항상 무음으로 재생되고, 씬 교체 시각은 에셋별 [씬 교체] 값이 정합니다.',
    }),

    fadeSecField(ctx, {
      id: 'blackout-sec',
      label: '암전 페이드',
      key: 'blackoutSec',
      range: { min: BLACKOUT_SEC_RANGE.min, max: BLACKOUT_SEC_RANGE.max, step: 0.5, unit: '초' },
      tip: '씬 런처 맨 위 [화면 암전] 버튼이 쓰는 길이입니다. 출력 화면만 검정으로 덮고 소리는 그대로 나갑니다. 0 → 완전 검정 전 구간 기준이라, 페이드 도중 다시 누르면 남은 거리만큼만 걸려 되돌아옵니다. 0이면 컷으로 즉시 검정이 됩니다.',
    }),
    fadeSecField(ctx, {
      id: 'music-fade-sec',
      label: '음악 페이드',
      key: 'musicFadeSec',
      tip: 'BGM 재생·재개는 무음에서 이 시간에 걸쳐 올라오고, 일시정지·정지는 다 내려간 뒤에 멈춥니다. 곡을 바꾸면 이전 곡이 내려가는 동안 새 곡이 겹쳐 올라옵니다(크로스페이드). 0이면 지금처럼 즉시 켜지고 끊깁니다. 페이드 도중 반대로 눌러도 현재 볼륨에서 이어지므로 소리가 튀지 않습니다.',
    }),
    fadeSecField(ctx, {
      id: 'backdrop-crossfade-sec',
      label: '사진 배경 크로스',
      key: 'backdropCrossfadeSec',
      tip: '대기 화면의 사진 배경을 켜고 끌 때 밝은 대기 영상과 사진이 비치는 대기 영상이 이 시간 동안 겹쳐 넘어갑니다. 0이면 즉시 교체합니다. 대기 화면이 아닌 씬에서 토글하면 크로스 없이 바로 목표 상태가 됩니다.',
    }),
    fadeSecField(ctx, {
      id: 'audio-cut-fade-sec',
      label: '컷 소리 페이드',
      key: 'audioCutFadeSec',
      range: { min: AUDIO_CUT_FADE_SEC_RANGE.min, max: AUDIO_CUT_FADE_SEC_RANGE.max, step: 0.1, unit: '초' },
      tip: '스킵·중단·씬 컷처럼 화면이 즉시 넘어가는 순간에도 소리는 이 시간 동안 내려간 뒤 멈춥니다. 화면은 기다리지 않습니다 — 컷은 컷대로 두고 소리만 뒤따라 사라집니다. 0이면 화면과 함께 즉시 끊깁니다. 행사 BGM은 이 값이 아니라 [음악 페이드]를 씁니다.',
    }),
    el('h3', { class: 'section__title', text: '음악 자동 이어재생' }),
    el(
      'div',
      { class: 'seg' },
      MUSIC_REPEAT_MODES.map((mode) =>
        el('button', {
          class: `seg__btn${s.settings.musicRepeat === mode ? ' is-on' : ''}`,
          type: 'button',
          text: `${s.settings.musicRepeat === mode ? '● ' : '○ '}${MUSIC_REPEAT_LABEL[mode]}`,
          attrs: {
            'aria-pressed': s.settings.musicRepeat === mode ? 'true' : 'false',
            'aria-label': `이어재생 ${MUSIC_REPEAT_LABEL[mode]}`,
          },
          data: { fid: `music-repeat-${mode}`, tip: MUSIC_REPEAT_TIP[mode] },
          on: { click: () => ctx.dispatch({ type: 'settings/patch', patch: { musicRepeat: mode } }) },
        }),
      ),
    ),
    el('p', {
      class: 'tabpane__hint',
      text: '기본은 [구간]입니다 — 곡이 끝나면 같은 행사 구간의 다음 곡으로 저절로 이어집니다. [전체]가 기본이 아닌 이유는 개회식 음악이 끝나고 1부 게임 음악으로 넘어가는 편이 더 놀랍기 때문입니다. 소리를 끊고 싶으면 [없음]을 고르세요. 바꿔도 지금 곡은 그대로이고 다음 곡부터 적용됩니다. 상단 미니 플레이어의 모드 칩으로도 바꿀 수 있습니다.',
    }),

    fadeSecField(ctx, {
      id: 'music-duck-sec',
      label: '영상 소리 덕킹',
      key: 'musicDuckSec',
      range: { min: MUSIC_DUCK_SEC_RANGE.min, max: MUSIC_DUCK_SEC_RANGE.max, step: 0.5, unit: '초' },
      tip: '소리 있는 영상 큐로 넘어갈 때 행사 BGM을 이 시간에 걸쳐 내립니다. 큐도 그만큼 늦게 나갑니다 — 화면이 넘어가는 순간에는 이미 조용해야 하기 때문입니다(기다리는 동안 큐시트에 취소 버튼이 뜹니다). 영상이 끝나 돌아올 때는 기다림 없이 같은 길이로 되돌아옵니다. 0이면 지연 없이 곧바로 진행합니다.',
    }),
    el(
      'div',
      { class: 'btnrow' },
      el('button', {
        class: `seg__btn${s.settings.autoDuckOnVideoAudio ? ' is-on' : ''}`,
        type: 'button',
        text: `${s.settings.autoDuckOnVideoAudio ? '☑ 영상 소리에 음악 자동 덕킹' : '☐ 영상 소리에 음악 자동 덕킹'}`,
        attrs: { 'aria-pressed': s.settings.autoDuckOnVideoAudio ? 'true' : 'false' },
        data: {
          fid: 'auto-duck',
          tip: '켜 두면 소리 있는 영상 큐로 넘어갈 때 행사 BGM이 자동으로 내려갔다가 영상이 끝나면 돌아옵니다. 소리 유무는 [영상·에셋] 탭 카드의 [🔊 소리 켬]/[🔇 무음] 플래그로 판정합니다 — 브라우저가 오디오 트랙 유무를 알려 주지 않기 때문입니다. 끄면 큐가 지연 없이 나가고 음악은 영상 소리와 그대로 겹칩니다.',
        },
        on: {
          click: () =>
            ctx.dispatch({
              type: 'settings/patch',
              patch: { autoDuckOnVideoAudio: !s.settings.autoDuckOnVideoAudio },
            }),
        },
      }),
    ),
    fadeSecField(ctx, {
      id: 'master-ramp-sec',
      label: '볼륨 램프',
      key: 'masterRampSec',
      range: { min: MASTER_RAMP_SEC_RANGE.min, max: MASTER_RAMP_SEC_RANGE.max, step: 0.5, unit: '초' },
      tip: '상단 바 [MEDIA]·[MUSIC] 두 축의 [→40%]·[→100%] 버튼이 볼륨을 옮기는 데 쓰는 시간입니다(두 축이 같은 값을 씁니다). 0%에서 100%까지 전 구간 기준이라 이동 거리가 짧으면 그만큼 짧게 끝납니다(→40%는 이 값의 60%). 버튼은 누른 축만 움직이고 다른 축은 그대로입니다. 가는 도중 다른 버튼을 누르거나 그 축 슬라이더를 잡으면 그 자리에서 방향이 바뀌므로 소리가 튀지 않습니다. 0이면 버튼이 즉시 값을 바꿉니다.',
    }),
    el('p', {
      class: 'tabpane__hint',
      text: '페이드 길이는 서로 독립입니다. 볼륨(MEDIA·MUSIC)을 페이드 도중에 움직여도 페이드는 흔들리지 않고 즉시 반영됩니다.',
    }),

    el('h3', { class: 'section__title', text: '슬로우 리플레이' }),
    el(
      'div',
      { class: 'btnrow' },
      el('button', {
        class: `seg__btn${s.settings.replayEnabled ? ' is-on' : ''}`,
        type: 'button',
        text: s.settings.replayEnabled ? '☑ 슬로우 리플레이 켬' : '☐ 슬로우 리플레이 끔',
        attrs: { 'aria-pressed': s.settings.replayEnabled ? 'true' : 'false' },
        data: {
          fid: 'replay-enabled',
          tip: '켜 두면 중계 화면(F2)에 서 있는 동안 카메라를 계속 되감기용으로 녹화합니다. R(또는 런처의 왼쪽 반쪽)이 마지막 몇 초를, Shift+R(오른쪽 [지금부터])이 두 번 눌러 잡은 구간을 느리게 되돌려 보여 줍니다. 들어가고 나오는 컷은 짧은 스팅어가 덮습니다. 소리는 녹화하지 않습니다. 끄면 녹화 자체를 하지 않아 전환 성능에 전혀 영향이 없습니다.',
        },
        on: {
          click: () =>
            ctx.dispatch({
              type: 'settings/patch',
              patch: { replayEnabled: !s.settings.replayEnabled },
            }),
        },
      }),
    ),
    fadeSecField(ctx, {
      id: 'replay-sec',
      label: '되감기 길이',
      key: 'replaySec',
      range: { min: REPLAY_SEC_RANGE.min, max: REPLAY_SEC_RANGE.max, step: 1, unit: '초' },
      tip: '리플레이가 몇 초 전부터 보여 줄지입니다. 길게 잡을수록 인코더가 들고 있는 구간이 길어져 메모리를 더 씁니다(10초 기준 60MB 안쪽). 값을 바꾸면 녹화가 새 길이로 다시 시작하므로 버퍼가 그만큼 다시 찹니다. 재생 도중 바꿔도 지금 재생은 흔들리지 않습니다.',
    }),
    el(
      'div',
      { class: 'field field--narrow' },
      el('label', {
        class: 'field__label',
        text: '재생 배속',
        attrs: { for: 'replay-rate' },
        data: {
          tip: '되감은 화면을 몇 배속으로 틀지입니다. 기본 0.5는 절반 속도라 10초 구간이 20초 동안 나갑니다. 0.1은 10분의 1 속도로 10초 구간이 100초 동안 나가는, 결정적 장면을 아주 느리게 보여 주려는 값입니다. 1.0은 같은 속도로 한 번 더 보여 주는 것과 같습니다.',
        },
        tabIndex: 0,
      }),
      el(
        'select',
        {
          class: 'input',
          id: 'replay-rate',
          data: { fid: 'replay-rate' },
          on: {
            change: (ev) =>
              ctx.dispatch({
                type: 'settings/patch',
                patch: { replayRate: Number((ev.target as HTMLSelectElement).value) },
              }),
          },
        },
        REPLAY_RATES.map((rate) =>
          el('option', {
            value: String(rate),
            text: `×${formatReplayRate(rate)}`,
            attrs: { selected: s.settings.replayRate === rate ? 'selected' : undefined },
          }),
        ),
      ),
    ),
    el('p', {
      class: 'tabpane__hint',
      text: '리플레이는 중계 화면에서만 돌아갑니다 — 다른 씬으로 넘어가면 녹화를 즉시 놓아 전환 영상이 프레임을 온전히 씁니다. 재생 중에는 화면 우하단에 REPLAY 배지가, 조작 패널 상단에 REPLAY 칩이 뜹니다. 끝까지 두면 저절로 라이브로 돌아오고, 그 복귀 컷도 들어갈 때와 같은 스팅어가 덮습니다.',
    }),

    /**
     * 씬 런처 버튼 복원 (U66). 넷 다 기본 꺼짐이고 여기서 개별로 되돌린다.
     * 순서·라벨의 정본은 `LAUNCHER_EXTRA_SCENES`와 `SCENE_LABELS`라 런처와 어긋날 수 없다.
     */
    el('h3', { class: 'section__title', text: '씬 런처 버튼' }),
    el(
      'div',
      { class: 'btnrow' },
      LAUNCHER_EXTRA_SCENES.map((scene) => {
        const on = s.settings.launcherExtraScenes[scene] === true;
        const label = SCENE_LABELS[scene];
        // 한 키만 담은 부분 패치 — `settings/patch`는 mergeDeep이라 나머지 셋은 그대로 남는다
        const patch: Partial<Record<LauncherExtraSceneId, boolean>> = { [scene]: !on };
        return el('button', {
          class: `seg__btn${on ? ' is-on' : ''}`,
          type: 'button',
          text: `${on ? '☑' : '☐'} ${label}`,
          attrs: { 'aria-pressed': on ? 'true' : 'false' },
          data: {
            fid: `launcher-scene-${scene}`,
            tip: `켜면 씬 런처에 [${label}] 버튼이 다시 올라옵니다. 꺼 두어도 큐시트로도 갈 수 있습니다${
              scene === 'photos' ? ' (F6 단축키도 그대로 살아 있습니다)' : ''
            }.`,
          },
          on: {
            click: () =>
              ctx.dispatch({
                type: 'settings/patch',
                patch: { launcherExtraScenes: patch },
              }),
          },
        });
      }),
    ),
    el('p', {
      class: 'tabpane__hint',
      text: '씬 런처는 기본으로 대기 화면·경기 중계·스코어보드·타이머 넷만 둡니다. 나머지 넷은 큐시트에서 순서대로 나가는 씬이라 런처에 두면 오조작 거리가 0이 됩니다. 필요할 때만 여기서 올리세요.',
    }),

    el('h3', { class: 'section__title', text: '보드 화면 호흡 글로우' }),
    el(
      'div',
      { class: 'btnrow' },
      el('button', {
        class: `seg__btn${s.settings.luxeGlow ? ' is-on' : ''}`,
        type: 'button',
        text: `${s.settings.luxeGlow ? '☑ 호흡 글로우 켬' : '☐ 호흡 글로우 끔'}`,
        attrs: { 'aria-pressed': s.settings.luxeGlow ? 'true' : 'false' },
        data: {
          fid: 'luxe-glow',
          tip: '순위·출전 명단·시상 보드의 가장자리가 5초 주기로 아주 느리게 밝아졌다 어두워집니다. 글자 위에는 걸리지 않고 테두리와 행 캡슐 rim에만 들어갑니다. 시스템 [동작 줄이기]가 켜져 있으면 이 설정과 무관하게 멈춥니다.',
        },
        on: {
          click: () =>
            ctx.dispatch({ type: 'settings/patch', patch: { luxeGlow: !s.settings.luxeGlow } }),
        },
      }),
    ),

    el('h3', { class: 'section__title', text: '분위기 반전' }),
    fadeSecField(ctx, {
      id: 'mood-total-sec',
      label: '전환 전체 길이',
      key: 'moodTotalSec',
      range: { min: MOOD_TOTAL_SEC_RANGE.min, max: MOOD_TOTAL_SEC_RANGE.max, step: 0.5, unit: '초' },
      tip: '큐를 누른 순간부터 반전 영상만 보이기까지의 시간입니다. 반전 영상은 누르는 즉시 백그라운드에서 재생을 시작하고 앞 15초가 검정이라, 이 값을 그 검정 길이에 맞춰야 소리와 그림이 어긋나지 않습니다. 글리치 구간은 여기서 아래 [암전 길이]를 뺀 나머지로 자동 계산됩니다.',
    }),
    fadeSecField(ctx, {
      id: 'mood-blackout-sec',
      label: '암전 길이',
      key: 'moodBlackoutSec',
      range: { min: MOOD_BLACKOUT_SEC_RANGE.min, max: MOOD_BLACKOUT_SEC_RANGE.max, step: 0.1, unit: '초' },
      tip: '전체 길이의 **끝 구간**에서 검정이 마저 차오르는 시간입니다. 검정은 그 앞에서 이미 절반쯤 올라와 있고, 이 구간에서도 글리치는 멈추지 않고 계속 심해집니다 — 검정이 완전히 덮은 뒤에야 캔버스를 내립니다.',
    }),
    el(
      'div',
      { class: 'field field--narrow' },
      el('label', {
        class: 'field__label',
        text: '디스토션 방식',
        attrs: { for: 'mood-distort-mode' },
        data: {
          tip: '픽셀 소터는 밝기 임계값을 넘는 구간을 밝기 순으로 정렬해 화면이 한 방향으로 흘러내리게 만듭니다. 세로는 위아래로 녹아내리고, 가로는 좌우로 번집니다. [보조 글리치만]은 정렬 없이 밀림·노이즈만 씁니다(가장 가볍습니다).',
        },
        tabIndex: 0,
      }),
      el(
        'select',
        {
          class: 'input input--select',
          id: 'mood-distort-mode',
          data: { fid: 'mood-distort-mode' },
          on: {
            change: (ev) => {
              const value = (ev.target as HTMLSelectElement).value as Settings['moodDistortMode'];
              ctx.dispatch({ type: 'settings/patch', patch: { moodDistortMode: value } });
            },
          },
        },
        (
          [
            ['pixel-sort-vertical', '픽셀 소터 · 세로'],
            ['pixel-sort-horizontal', '픽셀 소터 · 가로'],
            ['glitch-only', '보조 글리치만'],
          ] as const
        ).map(([value, label]) =>
          el('option', {
            value,
            text: label,
            attrs: { selected: s.settings.moodDistortMode === value ? 'selected' : undefined },
          }),
        ),
      ),
    ),
    fadeSecField(ctx, {
      id: 'mood-glitch-strength',
      label: '글리치 세기',
      key: 'moodGlitchStrength',
      range: { min: 0, max: 1, step: 0.05, unit: '' },
      tip: '0에 가까울수록 얌전하고 1이면 가장 심하게 무너집니다. 정렬 임계값과 번지는 범위, 보조 효과 양이 이 값 하나로 함께 움직입니다. 0이면 디스토션 없이 검정으로만 넘어갑니다.',
    }),
    el('p', {
      class: 'tabpane__hint',
      text: '글리치는 출력 창의 중계 카메라 화면을 소재로 씁니다. 카메라가 아직 열리지 않았으면 노이즈와 스캔라인만 나갑니다.',
    }),

    el('h3', { class: 'section__title', text: '단축키' }),
    el(
      'table',
      { class: 'hotkeytable' },
      el(
        'tbody',
        {},
        HOTKEYS.map(([k, v]) =>
          el('tr', {}, el('th', { class: 'mono-label', text: k }), el('td', { text: v })),
        ),
      ),
    ),
    el('p', {
      class: 'tabpane__hint',
      text: 'macOS는 시스템 설정 → 키보드에서 "F1, F2 등의 키를 표준 기능 키로 사용"을 켜 두세요. 단축키는 물리 키 기준이라 한글 입력 모드에서도 그대로 동작합니다. 텍스트 입력 중과 한글 조합 중에는 개입하지 않습니다.',
    }),

    el('h3', { class: 'section__title', text: '백업 · 복구' }),
    el(
      'div',
      { class: 'btnrow' },
      el('button', {
        class: 'btn',
        type: 'button',
        text: 'JSON 내보내기',
        data: { tip: '현재 상태 전체를 파일로 저장합니다 (에셋 영상 제외).' },
        on: {
          click: () => {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            download(`event-console-${stamp}.json`, serialize(s));
            toast('내보냈습니다');
          },
        },
      }),
      el('label', { class: 'btn', attrs: { for: 'import-json' } }, 'JSON 가져오기'),
      el('input', {
        class: 'visually-hidden',
        id: 'import-json',
        type: 'file',
        accept: 'application/json',
        data: { fid: 'import-json' },
        on: {
          change: (ev) => {
            const file = (ev.target as HTMLInputElement).files?.[0];
            if (!file) return;
            void file.text().then((text) => {
              try {
                const next = deserialize(text);
                openModal({
                  title: '상태 가져오기',
                  body: '현재 상태를 파일 내용으로 완전히 덮어씁니다. 계속할까요?',
                  danger: true,
                  confirmLabel: '덮어쓰기',
                  onConfirm: () => {
                    ctx.dispatch({ type: 'state/replace', state: next });
                    toast('가져왔습니다');
                  },
                });
              } catch {
                toast('파일을 읽지 못했습니다', 'bad');
              }
            });
          },
        },
      }),
      el('button', {
        class: 'btn',
        type: 'button',
        text: '스냅샷에서 복구',
        data: { tip: '5초마다 저장된 자동 스냅샷 중 하나를 골라 되돌립니다.' },
        on: {
          click: () => {
            void listSnapshots().then((snaps) => {
              if (!snaps.length) {
                toast('저장된 스냅샷이 없습니다', 'bad');
                return;
              }
              const list = el(
                'div',
                { class: 'snaplist' },
                snaps.slice(0, 20).map((sn) =>
                  el('button', {
                    class: 'btn btn--block',
                    type: 'button',
                    text: new Date(sn.ts).toLocaleString('ko-KR'),
                    on: {
                      click: () => {
                        ctx.dispatch({ type: 'state/replace', state: deserialize(sn.json) });
                        toast('스냅샷으로 복구했습니다', 'warn');
                        document.getElementById('modal-root')?.replaceChildren();
                      },
                    },
                  }),
                ),
              );
              openModal({ title: '스냅샷 복구', body: list, confirmLabel: '닫기', cancelLabel: '취소' });
            });
          },
        },
      }),
      el('button', {
        class: 'btn btn--danger',
        type: 'button',
        text: '전체 초기화',
        data: { tip: '점수·원장·설정·에셋을 모두 지웁니다. 확인 2단계.' },
        on: {
          click: () =>
            openModal({
              title: '전체 초기화',
              body: '점수·원장·설정·등록한 영상까지 모두 지웁니다. 되돌릴 수 없습니다. 계속하려면 RESET 을 입력하세요.',
              danger: true,
              confirmLabel: '초기화',
              requireText: 'RESET',
              onConfirm: () => {
                void clearAll().then(() => {
                  ctx.dispatch({ type: 'state/replace', state: createInitialState() });
                  toast('초기화했습니다', 'warn');
                });
              },
            }),
        },
      }),
    ),
  );
}
