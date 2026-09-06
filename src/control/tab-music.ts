import { formatMusicTime, MUSIC_TRACKS, musicProgress, musicTrack } from '../music';
import { bookmarkOf } from '../music-bookmarks';
import { el } from './dom';
import type { Ctx } from './ctx';
import type { MusicTrack } from '../music';

export const meta = { id: 'music', label: '음악' };

const SECTION_LABELS: Record<string, string> = {
  '01_아이스브레이크': '아이스브레이크',
  '02_개회식/01_웅장': '개회식 · 웅장',
  '02_개회식/02_신남': '개회식 · 신남',
  '03_팀소개': '팀 소개',
  '04_1부게임/01_끈끈이게임': '1부 · 끈끈이 게임',
  '04_1부게임/02_병뚜껑컬링': '1부 · 병뚜껑 컬링',
  '04_1부게임/03_신문지게임': '1부 · 신문지 게임',
  '04_1부게임/04_몸으로말해요': '1부 · 몸으로 말해요',
  '05_승리': '승리 발표', // U119 — 게임 승리팀 발표 전용 곡
  '07_미스터리': '미스터리 배경', // U133 — 후반 미스터리 반전 구간 배경음 ("2부" 낱말 금지, 2부 잠금 전에도 보이는 탭)
  '06_시상식': '시상식',
};

/** 곡을 고르지 않았을 때 기본으로 펼쳐 두는 섹션 */
const DEFAULT_OPEN_SECTION = '01_아이스브레이크';

/**
 * 사용자가 직접 펼치거나 접은 그룹 (섹션 → 열림). 순수 UI 상태라 `AppState`에 넣지 않는다.
 *
 * 음악 탭은 display의 3초 hello·`music-progress` 등으로 수시로 통째 재렌더된다. 열림 상태를
 * 매번 기본값으로 되돌리면, 다른 섹션 곡을 고르려고 펼쳐 둔 그룹이 클릭 전에 다시 접힌다 (D3).
 */
const groupOpenOverrides = new Map<string, boolean>();

/** 이 섹션을 펼친 채로 그려야 하는가. 사용자의 직접 조작이 기본값을 이긴다. */
export function musicGroupOpen(
  section: string,
  currentSection: string | undefined,
  overrides: ReadonlyMap<string, boolean>,
): boolean {
  const override = overrides.get(section);
  if (override !== undefined) return override;
  return currentSection === section || section === DEFAULT_OPEN_SECTION;
}

/**
 * `<details>` 하나의 toggle 기록기를 만든다.
 *
 * 렌더가 `open` 속성을 다는 것만으로도 toggle이 한 번 뜬다. **그 한 번만** 흘려보내고 그 뒤로는
 * 전부 사용자의 뜻으로 기록한다. "렌더한 값과 다를 때만 기록"으로 두면 렌더 시점 값에 고정돼,
 * 재렌더 전에 폈다 다시 접은 경우 닫힘이 기록되지 않고 override가 열림으로 굳는다 (D3 리뷰).
 */
export function musicGroupToggleRecorder(
  section: string,
  renderedOpen: boolean,
  overrides: Map<string, boolean>,
): (open: boolean) => void {
  let settled = false;
  return (open) => {
    const synthetic = !settled && open === renderedOpen;
    settled = true;
    if (synthetic) return;
    overrides.set(section, open);
  };
}

function groupedTracks(): Array<[string, MusicTrack[]]> {
  const groups = new Map<string, MusicTrack[]>();
  for (const track of MUSIC_TRACKS) {
    const rows = groups.get(track.section) ?? [];
    rows.push(track);
    groups.set(track.section, rows);
  }
  return [...groups.entries()];
}

/**
 * 지금 실제로 울리고 있는 위치. display telemetry가 신선하면 그 값, 아니면 마지막 명령 위치다.
 * `control.ts`의 B 단축키(U47)도 같은 값을 써야 버튼과 키가 다른 자리를 찍지 않는다.
 */
export function livePosition(ctx: Ctx): { t: number; d: number } {
  const current = musicTrack(ctx.state.music.trackId);
  const progress = ctx.status.musicProgress;
  if (
    progress &&
    Date.now() - progress.at < 2000 &&
    progress.trackId === ctx.state.music.trackId
  ) {
    return { t: progress.t, d: progress.d || current?.durationSec || 0 };
  }
  return { t: ctx.state.music.positionSec, d: current?.durationSec || 0 };
}

function updateScrubPreview(root: HTMLElement, t: number, d: number): void {
  const progress = musicProgress(t, d);
  root.style.setProperty('--music-progress', `${progress * 100}%`);
  const now = root.querySelector<HTMLElement>('[data-live="music-time"]');
  if (now) now.textContent = formatMusicTime(t);
}

/** `paintMusicProgress`(control.ts)가 200ms마다 DOM에 그대로 옮겨 쓰는 값 (U104 리뷰 m7). */
export interface MusicScrubPaint {
  /** `<input type="range">`에 세팅할 값 (`.value`) */
  value: number;
  /** `<input type="range">`의 `.max` — 곡 길이가 바뀌면 같이 바뀐다 */
  max: number;
  /** `--music-progress` CSS 변수에 세팅할 0~100 사이 백분율 */
  fillPercent: number;
  timeText: string;
  durationText: string;
  ariaValueText: string;
}

/**
 * 슬라이더 핸들·fill·시간 텍스트를 **한 계산식**에서 뽑는다 (U104 리뷰 m7).
 *
 * 전역 UI 규칙(슬라이더/플레이바)의 계약 그대로다 — 핸들 중심·fill 끝·진행률이 따로 계산되면
 * 반드시 어긋난다. 셋 다 이 함수 하나에서만 나오게 해서, `paintMusicProgress`가 세 개의
 * `querySelectorAll` 루프에서 각자 값을 계산하다 하나를 빠뜨리는 사고를 구조적으로 막는다.
 *
 * `held`(포인터 드래그·키보드 시크 중, `render-hold.ts`의 `'music-scrub'` 소유자)면 `null`을
 * 돌려준다 — 그 동안은 `updateScrubPreview`가 **입력값 그대로** fill·텍스트를 그리고 있으므로,
 * 여기서 손대면 옛(시크 전) 텔레메트리로 되돌리거나 매 200ms 두 그림이 서로 덮어써 깜빡인다.
 * 호출자는 `null`이면 DOM을 아예 건드리지 않아야 한다 — 부분 적용(예: 텍스트만 갱신)은
 * 핸들·fill·텍스트가 다시 어긋나는 것과 같은 사고다.
 */
export function musicScrubPaint(input: { held: boolean; t: number; d: number }): MusicScrubPaint | null {
  if (input.held) return null;
  const { t, d } = input;
  return {
    value: Math.min(t, d || t),
    max: Math.max(0, d),
    fillPercent: musicProgress(t, d) * 100,
    timeText: formatMusicTime(t),
    durationText: formatMusicTime(d),
    ariaValueText: `${formatMusicTime(t)} / ${formatMusicTime(d)}`,
  };
}

/** 방향키·Home/End·PageUp/Down — 네이티브 range가 값을 바로 바꾸는 키들 (U104 리뷰 m3). */
const RANGE_SEEK_KEYS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

/**
 * 키보드 시크 뒤 `music-scrub` 홀드를 놓는 예약 (U104 리뷰 m3).
 *
 * 포인터는 `pointerup`이 "손을 뗐다"는 확실한 신호를 주지만 키보드는 그런 신호가 없다 —
 * `change` 한 번으로 시크가 끝났다고 보고 바로 놓으면, `state.music.positionSec`은 이미
 * 새 값인데 display가 아직 그 위치를 텔레메트리로 되돌려 보내기 전인 짧은 틈(최대 200ms
 * 주기 하나)에 `paintMusicProgress`가 **옛(시크 전) telemetry**를 "신선함" 판정으로 읽어
 * 핸들을 되돌릴 수 있다. `change`마다 이 타이머를 다시 세워 **마지막 키 입력 400ms 뒤**에만
 * 놓는다 — 방향키를 눌러 쥐고 있어도 그 사이엔 계속 홀드가 유지된다.
 *
 * `holdRender`를 `Ctx` 전체가 아니라 이 함수 하나만 받는 이유는 테스트 때문이다 — 실제
 * 함수로 "keydown 뒤 400ms에 스스로 놓이는가"를 검증하려면 `Ctx`를 통째로 흉내 낼 필요 없이
 * 이 좁은 인터페이스만 채우면 된다(`control-leader.ts`의 `setTimeout` 주입과 같은 이유).
 * `window.` 접두 없이 전역 타이머를 쓰는 이유도 같다 — DOM 없는 Node 테스트 환경에서
 * `vi.useFakeTimers()`가 전역 `setTimeout`/`clearTimeout`을 그대로 가로챈다.
 */
let musicScrubKeyboardReleaseTimer = 0;

function armMusicScrubKeyboardRelease(holdRender: Ctx['holdRender']): void {
  clearTimeout(musicScrubKeyboardReleaseTimer);
  musicScrubKeyboardReleaseTimer = setTimeout(() => {
    holdRender('music-scrub', false);
  }, 400);
}

/**
 * 방향키·Home/End/PageUp/Down keydown 처리 (U104 재리뷰 Major).
 *
 * `render()`의 `keydown` 배선은 이 함수 하나를 부른다 — 잡는 동시에 해제 타이머도 같이
 * 세운다. **값이 이미 끝(0 또는 max)이면 네이티브 range는 더 눌러도 값이 안 바뀌어
 * `input`/`change`가 아예 안 뜬다** — 타이머를 `change`에만 걸어 두면 그 경우 홀드가 영영
 * 안 풀려 핸들·fill·시간 텍스트가 전부 멈춘다(곡을 끝까지 듣고 `End`를 한 번 더 누르면
 * 재현되는, U104 원래 증상과 같은 모양의 사고). `change`가 뒤따르면 거기서 타이머를 다시
 * 세우므로(연타에도 매번 최신화) 여기서 먼저 걸어도 안전하다.
 */
export function handleMusicScrubKeydown(holdRender: Ctx['holdRender'], key: string): void {
  if (!RANGE_SEEK_KEYS.has(key)) return;
  holdRender('music-scrub', true);
  armMusicScrubKeyboardRelease(holdRender);
}

export function render(ctx: Ctx): HTMLElement {
  const state = ctx.state.music;
  const current = musicTrack(state.trackId);
  const position = livePosition(ctx);
  const currentBookmark = bookmarkOf(state.bookmarks, state.trackId);

  const range = el('input', {
    class: 'music-player__range',
    type: 'range',
    min: 0,
    max: Math.max(0, position.d),
    step: 0.1,
    value: Math.min(position.t, position.d || position.t),
    disabled: !current || position.d <= 0,
    attrs: {
      'aria-label': '음악 재생 위치',
      'aria-valuetext': `${formatMusicTime(position.t)} / ${formatMusicTime(position.d)}`,
    },
    data: { fid: 'music-scrub' },
    on: {
      // 잡고 있는 동안 재렌더를 보류한다 (U43과 같은 배선, U104 근본 수정).
      // 네이티브 range는 클릭 한 번(드래그 없이)만으로도 포커스가 영영 남는다 — 예전에는
      // `paintMusicProgress`가 그 포커스를 "드래그 중"으로 오인해 핸들을 영구히 멈춰 세웠다.
      // 소유자를 `'music-scrub'`로 넘기는 이유는 U104 리뷰 m2/m4 — 볼륨 슬라이더(`'volume'`)와
      // 이 계약을 공유하므로 소유자를 구분하지 않으면 한쪽을 잡아도 다른 쪽이 같이 얼어붙거나
      // (m2), 둘을 동시에 잡은 채 한쪽만 놓아도 둘 다 풀린다(m4). 전역 안전망(창 밖에서
      // 손을 떼는 경우)은 control.ts에 이미 있다.
      pointerdown: () => ctx.holdRender('music-scrub', true),
      pointerup: () => ctx.holdRender('music-scrub', false),
      pointercancel: () => ctx.holdRender('music-scrub', false),
      lostpointercapture: () => ctx.holdRender('music-scrub', false),
      // 방향키·Home/End/PageUp/Down 시크 보호 (U104 리뷰 m3, 재리뷰 Major) — 실제 판정과
      // 해제 타이머 배선은 `handleMusicScrubKeydown`(계약은 그 함수 JSDoc 참고).
      keydown: (event) => handleMusicScrubKeydown(ctx.holdRender, event.key),
      input: (event) => {
        const input = event.currentTarget as HTMLInputElement;
        const player = input.closest<HTMLElement>('.music-player');
        if (player) updateScrubPreview(player, Number(input.value), Number(input.max));
      },
      change: (event) => {
        const input = event.currentTarget as HTMLInputElement;
        ctx.dispatch({ type: 'music/seek', positionSec: Number(input.value), now: Date.now() });
        // 키보드 시크 뒤 홀드를 400ms 늦게 놓는다 — 포인터 쪽은 pointerup이 이미 즉시
        // 놓으므로(위) 여기서 또 걸어도 안전한 재확인일 뿐이다(이미 놓인 소유자를 다시
        // 놓는 것은 무해하다).
        armMusicScrubKeyboardRelease(ctx.holdRender);
      },
    },
  });

  const player = el(
    'section',
    {
      class: `music-player${state.playing ? ' is-playing' : ''}`,
      style: `--music-progress:${musicProgress(position.t, position.d) * 100}%`,
    },
    el(
      'div',
      { class: 'music-player__head' },
      el('div', { class: 'music-player__eyebrow', text: state.playing ? '● NOW PLAYING' : '■ READY' }),
      el('strong', { class: 'music-player__title', text: current?.label ?? '선택된 음악 없음' }),
      current ? el('span', { class: 'music-player__section', text: SECTION_LABELS[current.section] ?? current.section }) : null,
    ),
    current?.warning ? el('p', { class: 'music-player__warning', text: `주의: ${current.warning}` }) : null,
    range,
    el(
      'div',
      { class: 'music-player__transport' },
      el('button', {
        class: 'btn btn--primary music-player__play',
        type: 'button',
        text: state.playing ? '❚❚ 일시정지' : '▶ 재생',
        disabled: !current,
        on: {
          click: () =>
            ctx.dispatch(
              state.playing
                ? { type: 'music/pause', positionSec: livePosition(ctx).t }
                : { type: 'music/resume' },
            ),
        },
      }),
      el('button', {
        class: 'btn',
        type: 'button',
        text: '■ 정지',
        disabled: !current,
        on: { click: () => ctx.dispatch({ type: 'music/stop', now: Date.now() }) },
      }),
      // 시작점 두 개 (U47). 리허설에서 찾아 둔 자리로 곧장 들어가는 것이 목적이므로
      // [처음부터]와 나란히 둔다 — 어느 쪽으로 트는지가 한눈에 보여야 한다.
      el('button', {
        class: 'btn',
        type: 'button',
        text: '↺ 처음부터',
        disabled: !current,
        data: { tip: '지금 곡을 0초부터 다시 재생합니다.' },
        on: {
          click: () =>
            current && ctx.dispatch({ type: 'music/play', trackId: current.id, now: Date.now() }),
        },
      }),
      currentBookmark !== null
        ? el('button', {
            class: 'btn',
            type: 'button',
            text: `⌖ ${formatMusicTime(currentBookmark)}부터`,
            data: { tip: `이 곡의 북마크(${formatMusicTime(currentBookmark)})부터 재생합니다.` },
            on: {
              click: () =>
                current &&
                ctx.dispatch({
                  type: 'music/play',
                  trackId: current.id,
                  startSec: currentBookmark,
                  now: Date.now(),
                }),
            },
          })
        : null,
      el('button', {
        class: `btn${currentBookmark !== null ? ' is-on' : ''}`,
        type: 'button',
        text: currentBookmark !== null ? '⌖ 북마크 옮기기' : '⌖ 북마크',
        disabled: !current,
        attrs: { 'aria-pressed': currentBookmark !== null ? 'true' : 'false' },
        data: {
          fid: 'music-bookmark',
          tip: '지금 재생 위치를 이 곡의 시작 북마크로 기억합니다(단축키 B). 곡마다 하나뿐이라 다시 찍으면 그 자리로 옮겨집니다. 곡을 바꾸거나 정지해도 남습니다. 맨 앞 1초 안쪽은 [처음부터]와 구별되지 않아 받지 않습니다.',
        },
        on: {
          click: () =>
            current &&
            ctx.dispatch({
              type: 'music/bookmark',
              trackId: current.id,
              positionSec: livePosition(ctx).t,
            }),
        },
      }),
      currentBookmark !== null
        ? el('button', {
            class: 'btn btn--ghost',
            type: 'button',
            text: '북마크 해제',
            data: { tip: '이 곡의 북마크를 지웁니다. 다른 곡의 북마크는 그대로입니다.' },
            on: {
              click: () => current && ctx.dispatch({ type: 'music/bookmarkClear', trackId: current.id }),
            },
          })
        : null,
      el(
        'div',
        { class: 'music-player__time mono-label' },
        el('span', { text: formatMusicTime(position.t), data: { live: 'music-time' } }),
        el('span', { text: ' / ' }),
        el('span', { text: formatMusicTime(position.d), data: { live: 'music-duration' } }),
      ),
    ),
  );

  return el(
    'div',
    { class: 'tabpane music-tab' },
    el('p', {
      class: 'tabpane__hint',
      text: '곡을 누르면 출력 창에서 즉시 재생됩니다. 타임라인은 클릭·드래그로 이동하며, 마스터 볼륨을 따릅니다.',
    }),
    player,
    el(
      'div',
      { class: 'music-library' },
      groupedTracks().map(([section, tracks]) => {
        const wantOpen = musicGroupOpen(section, current?.section, groupOpenOverrides);
        const group = el(
          'details',
          {
            class: 'music-group',
            attrs: wantOpen ? { open: true } : {},
          },
          el(
            'summary',
            { class: 'music-group__summary' },
            el('strong', { text: SECTION_LABELS[section] ?? section }),
            el('span', { class: 'chip', text: `${tracks.length}곡` }),
          ),
          el(
            'div',
            { class: 'music-group__rows' },
            tracks.map((track) => {
              const active = track.id === state.trackId;
              return el(
                'div',
                { class: `music-row${active ? ' is-active' : ''}` },
                el('span', { class: 'music-row__id mono-label', text: track.id }),
                el(
                  'div',
                  { class: 'music-row__main' },
                  el('strong', { class: 'music-row__label', text: track.label }),
                  track.warning ? el('span', { class: 'music-row__warning', text: track.warning }) : null,
                ),
                el('span', { class: 'music-row__duration mono-label', text: formatMusicTime(track.durationSec) }),
                el('button', {
                  class: `btn btn--tiny${active ? ' btn--primary' : ''}`,
                  type: 'button',
                  text: active && state.playing ? '↺ 처음부터' : '▶ 재생',
                  attrs: { 'aria-label': `${track.label} 처음부터 재생` },
                  data: { tip: '이 곡을 0초부터 재생합니다.' },
                  on: { click: () => ctx.dispatch({ type: 'music/play', trackId: track.id, now: Date.now() }) },
                }),
                // 북마크가 있는 곡에만 붙인다 (U47) — 없는 곡에 회색 버튼을 두면
                // 모든 행이 두 칸으로 길어지고 "왜 못 누르나"를 매번 묻게 된다
                bookmarkOf(state.bookmarks, track.id) !== null
                  ? el('button', {
                      class: 'btn btn--tiny music-row__bookmark',
                      type: 'button',
                      text: `⌖ ${formatMusicTime(bookmarkOf(state.bookmarks, track.id) ?? 0)}`,
                      attrs: { 'aria-label': `${track.label} 북마크부터 재생` },
                      data: {
                        tip: `이 곡의 북마크(${formatMusicTime(bookmarkOf(state.bookmarks, track.id) ?? 0)})부터 재생합니다. 북마크는 재생 중 B 키 또는 플레이어의 [⌖ 북마크]로 지금 위치에 찍습니다.`,
                      },
                      on: {
                        click: () =>
                          ctx.dispatch({
                            type: 'music/play',
                            trackId: track.id,
                            startSec: bookmarkOf(state.bookmarks, track.id) ?? 0,
                            now: Date.now(),
                          }),
                      },
                    })
                  : null,
              );
            }),
          ),
        );
        const record = musicGroupToggleRecorder(section, wantOpen, groupOpenOverrides);
        group.addEventListener('toggle', () => record(group.open));
        return group;
      }),
    ),
    el('p', {
      class: 'music-tab__empty-note',
      text: '몸으로 말해요 구간은 선곡 메모상 별도 음원이 없습니다.',
    }),
  );
}
