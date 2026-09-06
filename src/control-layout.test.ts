// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { declOf, stripComments } from './scenes/luxe-css.testkit';

const css = readFileSync(new URL('./styles/control.css', import.meta.url), 'utf8');
const controlSource = readFileSync(new URL('./control.ts', import.meta.url), 'utf8');
const assetSource = readFileSync(new URL('./control/tab-assets.ts', import.meta.url), 'utf8');
const rosterSource = readFileSync(new URL('./control/tab-roster.ts', import.meta.url), 'utf8');
const timerSource = readFileSync(new URL('./control/tab-timer.ts', import.meta.url), 'utf8');

describe('조작 패널 상단 탭 레이아웃', () => {
  it('1부만 사용 가능 폭에 따라 안전 최소폭으로 종목·값 입력 열을 자동 결정한다', () => {
    expect(css).toMatch(
      /\.tabpane--p1\s+\.eventgrid\s*\{[^}]*repeat\(auto-fit,\s*minmax\(min\(540px,\s*100%\),\s*1fr\)\)/,
    );
    expect(css).toMatch(
      /\.tabpane--p1\s+\.p1-value-inputs\s*\{[^}]*repeat\(auto-fit,\s*minmax\(min\(210px,\s*100%\),\s*1fr\)\)/,
    );
    expect(css).not.toMatch(/@media\s*\(max-width:\s*1400px\)/);
  });

  it('탭이 좁아지면 가로 스크롤 대신 다음 줄로 감싼다', () => {
    const blocks = [...css.matchAll(/\.tabbar\s*\{([^}]*)\}/g)].map((match) => match[1]);
    const block = blocks.find((candidate) => /display:\s*flex/.test(candidate)) ?? '';
    expect(block).toMatch(/flex-wrap:\s*wrap/);
    expect(block).not.toMatch(/overflow-x:\s*(?:auto|scroll)/);
    expect(block).not.toMatch(/overflow-y:\s*hidden/);
  });

  /**
   * U78 — 꼬리 세 탭을 꺽쇠 하나 뒤로 접는다. 묶음이 `display: contents`가 아니면
   * 펼칠 때 상자가 하나 생기며 탭 줄이 밀린다(레이아웃 점프).
   */
  it('숨긴 탭 묶음은 상자 없이 접히고, 꺽쇠는 탭 크기 고스트 버튼이다', () => {
    const more = css.match(/\.tabbar__more\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(more).toMatch(/display:\s*contents/);
    // UA의 `[hidden]`은 작성자 스타일보다 약하다 — 명시적으로 다시 눌러야 실제로 접힌다
    expect(css).toMatch(/\.tabbar__more\[hidden\]\s*\{[^}]*display:\s*none/s);

    const btn = css.match(/\.tabbar__more-btn\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(btn).toMatch(/background:\s*transparent/);
    expect(btn).toMatch(/border:\s*none/);
    // 자간은 0 또는 음수만 (한글 UI 규칙)
    expect(btn).not.toMatch(/letter-spacing:\s*[0-9.]+(?:em|px|rem)/);
    expect(css).toMatch(/\.tabbar__more-btn\.is-on\s+\.tabbar__more-caret\s*\{[^}]*transform:\s*rotate/s);
  });

  it('탭 바 꺽쇠가 펼침 상태를 스크린리더에 알리고 설정에 저장한다 (U78)', () => {
    expect(controlSource).toMatch(/'aria-expanded':\s*moreOpen/);
    expect(controlSource).toMatch(/'aria-controls':\s*'tabbar-more'/);
    expect(controlSource).toMatch(/tabbarMoreOpen:\s*!moreOpen/);
    // 방향키가 접힌 탭을 건너뛰는 근거는 렌더와 같은 한 함수여야 한다
    expect(controlSource).toMatch(/const enabledIds = visibleTabIds\(/);
  });

  it('볼륨은 숨은 원형 노브가 아니라 보이는 가로 슬라이더다', () => {
    const slider = css.match(/\.volume-slider\s*\{([^}]*)\}/)?.[1] ?? '';
    const input = css.match(/\.volume-slider__input\s*\{([^}]*)\}/)?.[1] ?? '';

    expect(slider).toMatch(/display:\s*(?:flex|grid)/);
    expect(input).toMatch(/width:\s*(?:clamp|min|max|\d)/);
    expect(input).not.toMatch(/opacity:\s*0/);
    expect(css).not.toMatch(/\.volume-knob__dial/);
  });

  it('볼륨 램프 버튼은 CSS 규칙을 가지고, 걷어낸 전환 스위처 규칙은 남지 않는다 (U43)', () => {
    // U45 — 축 묶음(MEDIA · MUSIC)도 규칙이 있어야 한다
    expect(css).toMatch(/\.volume-axis\s*\{/);
    expect(css).toMatch(/\.volume-ramp\s*\{/);
    expect(css).toMatch(/\.volume-ramp__btn\s*\{/);
    expect(css).toMatch(/\.volume-ramp__btn\.is-on\s*\{/);
    // 램프 중에도 상단 바가 흔들리지 않아야 한다 — 폭 고정 + nowrap
    expect(css).toMatch(/\.volume-slider__value\s*\{[^}]*white-space:\s*nowrap/s);
    expect(css).not.toMatch(/\.transition-picker/);
  });

  /**
   * 걷어낸 UI의 CSS가 남으면 다음 사람이 그 클래스를 되살릴 근거로 읽는다.
   * 셀렉터는 **생산자가 사라지는 순간** 같이 지운다 (리뷰 지적).
   */
  it('걷어낸 UI의 죽은 셀렉터가 남지 않는다', () => {
    const tokens = readFileSync(new URL('./styles/tokens.css', import.meta.url), 'utf8');
    // U49에서 없앤 런처 후반부 퀵 카드
    expect(css).not.toMatch(/\.launcher__locked/);
    // U46에서 모노그램으로 갈린 뒤 호출자가 사라진 패널 엠블럼 호스트
    expect(tokens).not.toMatch(/\.emblem-host/);
    const emblemSource = readFileSync(new URL('./emblem.ts', import.meta.url), 'utf8');
    expect(emblemSource).not.toContain('export function emblemElement');
  });

  it('덕킹 대기 칩은 CSS 규칙과 라이브 슬롯·취소 경로를 갖춘다 (U44)', () => {
    const cuesheetSource = readFileSync(new URL('./control/cuesheet.ts', import.meta.url), 'utf8');
    expect(css).toMatch(/\.duck-wait\s*\{/);
    expect(css).toMatch(/\.duck-wait__count\s*\{/);
    // 상단 바·큐시트가 카운트다운으로 흔들리면 안 된다
    expect(css).toMatch(/\.duck-wait\s*\{[^}]*white-space:\s*nowrap/s);
    expect(cuesheetSource).toContain('duck-count');
    expect(cuesheetSource).toContain('cancelDeferredCue');
    expect(cuesheetSource).toContain('needsMusicDuck');
    // 남은 초는 전체 재렌더가 아니라 200ms 라이브 갱신이 채운다
    expect(controlSource).toContain('function paintDuckCountdown(');
    expect(controlSource).toContain('[data-live="duck-count"]');
    // 복귀는 한 자리에서 — 경로마다 심으면 반드시 한 군데를 빠뜨린다
    expect(controlSource).toContain('videoAudioOwnsOutput');
    expect(controlSource).toContain("type: 'music/unduck'");
    // 리더가 바뀌면 예약은 폐기된다
    expect(controlSource).toMatch(/clearFullVideoWatchdog\(\);[\s\S]{0,240}clearDeferredCue\(\);/);
  });

  it('큐 경계 전환 선택은 이음선 위에 있고 켠 상태를 다중 신호로 알린다 (U42)', () => {
    const cuesheetSource = readFileSync(new URL('./control/cuesheet.ts', import.meta.url), 'utf8');
    expect(css).toMatch(/\.cue-boundary\s*\{/);
    expect(css).toMatch(/\.cue-boundary__line\s*\{/);
    // 색 하나로만 알리면 안 된다 — 테두리·바탕까지 함께 바뀐다
    const on = css.match(/\.cue-boundary__btn\.is-on\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(on).toMatch(/border-color:/);
    expect(on).toMatch(/background:/);
    expect(on).toMatch(/color:/);
    // 경계 줄이 큐시트를 세로로 밀지 않게 nowrap
    expect(css).toMatch(/\.cue-boundary\s*\{[^}]*white-space:\s*nowrap/s);
    expect(cuesheetSource).toContain('function cueBoundary(');
    expect(cuesheetSource).toContain("type: 'cueTransitions/clear'");
    // 순차 진행에서만 적용 — 직접 클릭은 전역
    expect(cuesheetSource).toContain('sequential ? cueTransitionOf(');
  });

  it('음악 플레이어는 고정 transport와 compact 선곡 행을 제공한다', () => {
    expect(css).toMatch(/\.music-player\s*\{[^}]*position:\s*sticky/);
    expect(css).toMatch(/\.music-player__range\s*\{[^}]*width:\s*100%/);
    expect(css).toMatch(/\.music-row\s*\{[^}]*grid-template-columns:/);
  });

  it('display 음악 telemetry를 200ms live DOM 갱신에 반영한다', () => {
    expect(controlSource).toMatch(/function paintMusicProgress\(/);
    expect(controlSource).toMatch(/paintVideoProgress\(now\);\s*paintMusicProgress\(now\);/);
    expect(controlSource).toMatch(/status\.musicProgress = musicProgress;\s*paintMusicProgress\(Date\.now\(\)\);/);
    expect(controlSource).toContain('[data-live="music-time"]');
    expect(controlSource).toContain('.music-player__range');
  });

  /**
   * U104 (+ 04:54 배치 리뷰 m2/m3/m4/m7) — 슬라이더를 한 번이라도 클릭하면(드래그 없이도)
   * 네이티브 range는 포커스를 영영 물고 있는다. `paintMusicProgress`가 그 포커스를 "드래그
   * 중"으로 오인해 핸들만 멈춰 세웠다(시간 텍스트·`--music-progress`는 계속 흐르는데 핸들만
   * 그대로 — 사용자 신고 그대로). 수정은 U43에서 검증된 "잡음/놓음"(`renderHold`) 상태 머신을
   * 소유자 집합으로 재사용한다.
   *
   * 이 테스트는 **배선이 존재하는가**만 소스로 확인한다(DOM 없는 `environment: 'node'`라
   * control.ts/tab-music.ts를 직접 실행할 수 없다). 실제 계산이 옳은지·held일 때 정말
   * 멈추는지·소유자가 서로 독립인지·동시 홀드 중 부분 해제가 안전한지는 **실제 함수를 호출해**
   * `control/tab-music.test.ts`(`musicScrubPaint`, m7)와 `control/render-hold.test.ts`
   * (소유자 집합, m2/m4)가 검증한다 — 여기서 다시 정규식으로 흉내 내지 않는다.
   */
  it('음악 슬라이더는 musicScrubPaint 한 곳으로 그리고, 볼륨과 독립된 소유자로 재렌더를 보류하며, 키보드 시크도 보호한다 (U104 배선)', () => {
    const musicSource = readFileSync(new URL('./control/tab-music.ts', import.meta.url), 'utf8');
    const topbarSource = readFileSync(new URL('./control/topbar.ts', import.meta.url), 'utf8');
    const renderHoldSource = readFileSync(new URL('./control/render-hold.ts', import.meta.url), 'utf8');

    // m7 — 페인트 루프는 musicScrubPaint 하나로 값을 얻고, null(잡는 동안)이면 통째로 손을 뗀다
    expect(controlSource).toContain('musicScrubPaint');
    expect(controlSource).toMatch(/const scrub = musicScrubPaint\(\{ held: isHeld\(renderHold, 'music-scrub'\), t, d \}\);\s*\n\s*if \(!scrub\) return;/);
    // 옛 가드(포커스 기반, m2 이전의 전역 boolean)가 되살아나지 않았는지
    expect(controlSource).not.toMatch(/document\.activeElement === node\)\s*continue;/);
    expect(controlSource).not.toMatch(/if \(renderHold\.holding\)/);

    // U43·m2 — 음악은 'music-scrub', 볼륨은 'volume'. 소유자를 안 나누면 한쪽을 잡을 때
    // 다른 쪽도 얼어붙는다(m2) — 실제 독립성 자체는 render-hold.test.ts가 검증한다.
    expect(musicSource).toContain("pointerdown: () => ctx.holdRender('music-scrub', true)");
    expect(musicSource).toContain("pointerup: () => ctx.holdRender('music-scrub', false)");
    expect(musicSource).toContain("pointercancel: () => ctx.holdRender('music-scrub', false)");
    expect(musicSource).toContain("lostpointercapture: () => ctx.holdRender('music-scrub', false)");
    expect(topbarSource).toContain("ctx.holdRender('volume', true)");
    expect(topbarSource).toContain("ctx.holdRender('volume', false)");

    // 전역 안전망(창 밖에서 손을 떼는 경우)은 소유자를 모르므로 releaseAllRenderHolds로 전부 놓는다
    expect(controlSource).toContain("window.addEventListener('pointerup', releaseAllRenderHolds);");
    expect(controlSource).toContain("window.addEventListener('pointercancel', releaseAllRenderHolds);");
    expect(controlSource).toContain("window.addEventListener('blur', releaseAllRenderHolds);");

    // m4 — render-hold.ts가 boolean 하나가 아니라 소유자 Set을 쓴다(옛 필드 부재 확인)
    const renderHoldInterface = renderHoldSource.match(/export interface RenderHold \{([\s\S]*?)\}/)?.[1] ?? '';
    expect(renderHoldInterface).toContain('owners: ReadonlySet<RenderHoldOwner>');
    expect(renderHoldInterface).not.toMatch(/^\s*holding:\s*boolean;/m);
    expect(renderHoldSource).toContain('export function releaseAllRender(');

    // m3/재리뷰 Major — keydown은 handleMusicScrubKeydown 한 곳에 위임한다(홀드+타이머를
    // 같이 세운다 — 값이 안 바뀌어 change가 안 오는 경우에도 스스로 풀려야 한다). 실제
    // "값 변화 없는 keydown 뒤에도 400ms에 풀리는가"는 `tab-music.test.ts`가 가짜 타이머로
    // 실행해 검증한다(여기는 배선 존재만 확인).
    expect(musicSource).toContain('RANGE_SEEK_KEYS');
    expect(musicSource).toContain('export function handleMusicScrubKeydown(');
    expect(musicSource).toContain("keydown: (event) => handleMusicScrubKeydown(ctx.holdRender, event.key)");
    // change에서도 재확인 배선(재입력 시 타이머 갱신)이 남아 있는지
    expect(musicSource).toContain('armMusicScrubKeyboardRelease(ctx.holdRender)');
  });

  it('에셋은 16:9 썸네일 카드 그리드이고 저빈도 설정만 disclosure 안에 둔다 (U39)', () => {
    const grid = css.match(/\.assetgrid\s*\{([^}]*)\}/)?.[1] ?? '';
    const thumb = css.match(/\.assetcard__thumb\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(assetSource).toContain("'details'");
    expect(assetSource).toContain("class: 'assetcard__settings'");
    expect(assetSource).toContain("class: 'assetcard__settings-summary'");
    // 카드 폭 260px — 1261px 조작 폭에서 3열, 넓은 화면에서 4열
    expect(grid).toMatch(/repeat\(auto-fill,\s*minmax\(min\(260px,\s*100%\),\s*1fr\)\)/);
    expect(thumb).toMatch(/aspect-ratio:\s*16\s*\/\s*9/);
    expect(css).toMatch(/\.assetcard__settings-summary\s*\{/);
    // 옛 콤팩트 행 잔재가 남아 있으면 두 레이아웃이 섞인다
    expect(css).not.toMatch(/\.assetlist\s*\{/);
    expect(assetSource).not.toContain("class: 'asset__main'");
  });

  it('출전 명단은 팀별 프리셋 chip과 커스텀 입력을 함께 제공한다', () => {
    expect(rosterSource).toContain("class: 'roster-presets'");
    expect(rosterSource).toContain('roster-preset__chip');
    expect(rosterSource).toContain('input input--area');
    expect(rosterSource).toContain('--preset:');
    expect(css).toMatch(/\.rostergrid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
    expect(css).toMatch(/\.roster-presets\s*\{/);
    expect(css).toMatch(/\.roster-preset__chip\.is-on\s*\{/);
    expect(css).toMatch(/\.rostercard \.input--area\s*\{[^}]*min-height:\s*58px/s);
  });

  it('타이머 탭은 전용 스코프에서 남은 시간만 낮추고, 보조 텍스트는 다른 탭과 같은 기본 크기를 쓴다 (U99, U67 되돌림)', () => {
    // 테스트 환경이 `environment: 'node'`(DOM 없음)라 render(ctx)를 직접 부를 수 없다 —
    // 렌더가 스코프 클래스를 실제로 붙이는지는 소스 텍스트로 확인한다.
    expect(timerSource).toContain("class: 'tabpane tabpane--timer'");
    expect(css).toMatch(/\.tabpane--timer\s/);

    // 숫자 위에 "남은 시간" 라벨이 붙는다
    expect(timerSource).toContain("class: 'timerpanel__label'");
    expect(timerSource).toContain("text: '남은 시간'");
    const label = css.match(/\.tabpane--timer\s+\.timerpanel__label\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(label).toMatch(/font-size:\s*13px/);

    // 라벨과 숫자가 aria로 묶여 있어야 스크린리더가 "남은 시간 12:34"로 한 번에 읽는다 (리뷰 n2)
    expect(timerSource).toContain("id: 'timer-label'");
    expect(timerSource).toContain("'aria-labelledby': 'timer-label'");

    // 남은 시간 숫자는 U67의 88~132px보다 낮춘 56~84px — 반응형 + tabular-nums 유지
    const time = css.match(/\.tabpane--timer\s+\.timerpanel__time\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(time).toMatch(/font-variant-numeric:\s*tabular-nums/);
    expect(time).toMatch(/font-size:\s*clamp\(56px,\s*7vw,\s*84px\)/);

    // 마지막 10초 레드는 스코프 안에서도 살아 있어야 한다 (색만 — transform/filter 애니메이션 금지)
    const danger = css.match(/\.tabpane--timer\s+\.timerpanel__time\.is-danger\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(danger).toMatch(/color:\s*var\(--danger-soft\)/);
    expect(danger).not.toMatch(/transform:|filter:|animation:/);

    // U67이 70%로 줄였던 보조 텍스트 스코프 규칙(안내·상태·버튼·섹션 제목)은
    // 전부 지워졌다 — 기본 규칙에 위임되어 다른 탭과 같은 크기로 보인다.
    // (프리셋 wrap 배치·커스텀 입력 폭/높이·고스트 버튼 정렬은 U67 그대로 남아 있다 — 그건 크기가 아니라 배치다.)
    expect(css).not.toMatch(/\.tabpane--timer\s+\.tabpane__hint\s*\{/);
    expect(css).not.toMatch(/\.tabpane--timer\s+\.timerpanel__state\s*\{/);
    expect(css).not.toMatch(/\.tabpane--timer\s+\.timerpanel__controls\s+\.btn--big\s*\{/);
    expect(css).not.toMatch(/\.tabpane--timer\s+\.section__title\s*\{/);
    expect(css).not.toMatch(/\.tabpane--timer\s+\.preset\s*\{/); // bare .preset 칩 축소는 지워짐 (preset--custom .input--num은 남음)
    expect(css).not.toMatch(/\.tabpane--timer\s+\.preset--custom\s*\{/);
    expect(css).not.toMatch(/\.tabpane--timer\s+\.preset--custom\s+\.field__label\s*\{/);

    // U67 배치는 그대로 — pill wrap 프리셋 줄, 고스트 버튼 정렬, 커스텀 입력 컴팩트 폭/높이
    const presetgridScoped = css.match(/\.tabpane--timer\s+\.presetgrid\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(presetgridScoped).toMatch(/display:\s*flex/);
    expect(presetgridScoped).toMatch(/flex-wrap:\s*wrap/);
    expect(presetgridScoped).not.toMatch(/font-size/);
    const ghostScoped = css.match(/\.tabpane--timer\s*>\s*\.btn--ghost\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(ghostScoped).toMatch(/align-self:\s*flex-start/);
    const customInputScoped = css.match(/\.tabpane--timer\s+\.preset--custom\s+\.input--num\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(customInputScoped).toMatch(/width:\s*62px/);
    expect(customInputScoped).toMatch(/min-height:\s*24px/);
    // 글자 크기는 스코프에서 아예 선언하지 않는다 — 기본 규칙(14px)에 위임(값을 다시 적지 않는다)
    expect(customInputScoped).not.toMatch(/font-size/);
    expect(declOf(css, '.preset--custom .input--num', 'font-size')).toBe('14px');

    // U67 잔존 수치(8.75/8.4/10.15/9.1px)가 타이머 스코프 안에 남아있지 않은지 못박는다 —
    // 전체 control.css가 아니라 `.tabpane--timer` 스코프 규칙만 모은 슬라이스에서 확인한다.
    const timerRules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, selector]) =>
      // 선택자 캡처 앞에 여러 줄 주석이 붙는 규칙이 많아 `^`만으로는 놓친다 — 주석 뒤(`*/`)에서
      // 시작하는 경우도 스코프 규칙으로 센다.
      /(^|\*\/)\s*\.tabpane--timer\b/.test(selector),
    );
    expect(timerRules.length).toBeGreaterThan(5);
    const timerScopedCss = timerRules.map(([full]) => full).join('\n');
    expect(timerScopedCss).not.toMatch(/8\.75px|8\.4px|10\.15px|9\.1px/);

    // 기본 규칙이 실제로 요청된 크기를 낸다 — 안내 12.5px·상태 12px·버튼 14.5px·섹션 제목 13px·프리셋 13px
    expect(declOf(css, '.tabpane__hint', 'font-size')).toBe('12.5px');
    expect(declOf(css, '.timerpanel__state', 'font-size')).toBe('12px');
    expect(declOf(css, '.btn--big', 'font-size')).toBe('14.5px');
    expect(declOf(css, '.section__title', 'font-size')).toBe('13px');
    expect(declOf(css, '.preset', 'font-size')).toBe('13px');

    // 자간은 0 또는 음수만 — 한글은 양수 자간에서 금방 엉성해진다
    const positiveTracking = timerRules
      .flatMap(([, selector, body]) =>
        [...body.matchAll(/letter-spacing:\s*([^;]+);/g)].map((m) => `${selector.trim()} → ${m[1].trim()}`),
      )
      .filter((entry) => !/→\s*(?:0|-)/.test(entry));
    expect(positiveTracking).toEqual([]);
  });

  it('카메라 상태는 눌러서 설정을 여는 액션으로 식별된다', () => {
    const action = css.match(/\.status-dot--action\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(action).toMatch(/cursor:\s*pointer/);
    expect(action).toMatch(/box-shadow:/);
  });

  /**
   * U115 — 06:2x 사용자 스크린샷 실사고. 좁은 창(1024~1280)에서 미니 플레이어 트랜스포트
   * 버튼·이어재생 배지가 MEDIA 볼륨 축 위에 그대로 겹쳐 그려졌다.
   *
   * 근본 원인: `.topbar__scene`·`.miniplayer`에 있던 `min-width: 0`이 flex 아이템을
   * 내용보다 좁게 찌그러뜨리는데, 그 안의 nowrap·고정폭 자식(장면명 텍스트, 트랜스포트
   * 버튼)은 줄어들지 않고 `overflow` 클리핑도 없어 찌그러진 박스 밖으로 그대로 그려져
   * 옆 형제를 뒤덮었다. 실측(Playwright, 1440/1280/1100/1024/900/820px)으로 재현·검증했다.
   *
   * 수정: ① 상단 바를 1행(씬·FREEZE·타이머·상태)/2행(미니 플레이어·MEDIA·MUSIC)으로 나누고
   * 각 행에 `flex-wrap: wrap`을 둔다 — 안 맞으면 잘리거나 겹치지 않고 다음 줄로 흐른다.
   * ② 문제의 `min-width: 0`을 걷어내 자동 최소 크기(내용만큼)를 되찾는다.
   * ③ 볼륨 축은 슬라이더 아래에 램프를 쌓던 2행 그리드를 걷어내고 한 줄 인라인으로 바꿔
   * 램프 버튼이 항상 슬라이더 오른쪽에 붙는다(세로로 쌓지 않는다).
   */
  describe('U115 — 상단 바 2행 정리 (겹침 수정)', () => {
    it('상단 바는 1행/2행 구조이고, 각 행은 wrap이 걸려 있어 넘치면 겹치지 않고 다음 줄로 흐른다', () => {
      const topbarSource = readFileSync(new URL('./control/topbar.ts', import.meta.url), 'utf8');
      expect(topbarSource).toContain("class: 'topbar__row topbar__row--1'");
      expect(topbarSource).toContain("class: 'topbar__row topbar__row--2'");
      // 2행 = 미니 플레이어 + 두 볼륨 축. 순서가 바뀌면 겹침 재현 시나리오와 어긋난다.
      expect(topbarSource).toMatch(
        /class:\s*'topbar__row topbar__row--2'\s*\},\s*musicMiniPlayer\(ctx\),\s*VOLUME_AXES\.map\(\(axis\) => volumeAxisControl\(ctx, axis, now\)\),/,
      );

      const row = css.match(/\.topbar__row\s*\{([^}]*)\}/)?.[1] ?? '';
      expect(row).toMatch(/flex-wrap:\s*wrap/);
      expect(row).not.toMatch(/overflow-x:\s*(?:auto|scroll)/);

      // 컨테이너 자체는 세로로 두 행을 쌓는다(옛 고정 height: 64px 한 줄 레이아웃이 아니다)
      const topbar = css.match(/^\.topbar\s*\{([^}]*)\}/m)?.[1] ?? '';
      expect(topbar).toMatch(/flex-direction:\s*column/);
      expect(topbar).not.toMatch(/height:\s*64px/);
    });

    it('겹침의 진짜 원인이던 min-width: 0을 씬 묶음·미니 플레이어에서 걷어냈다', () => {
      // 선언(세미콜론 동반)만 찾는다 — 주석 설명문에는 "min-width: 0"이라는 문구가
      // 그대로 등장하므로(원인 설명), 세미콜론 없는 산문까지 걸리면 오탐이다.
      const scene = stripComments(css).match(/\.topbar__scene\s*\{([^}]*)\}/)?.[1] ?? '';
      expect(scene).not.toMatch(/min-width:\s*0;/);

      const mini = stripComments(css).match(/^\.miniplayer\s*\{([^}]*)\}/m)?.[1] ?? '';
      expect(mini).not.toMatch(/min-width:\s*0;/);
      // 곡 제목 말줄임은 그대로 살아 있어야 한다 — `.miniplayer__now`의 자체 min-width: 0이 담당
      const now = css.match(/\.miniplayer__now\s*\{([^}]*)\}/)?.[1] ?? '';
      expect(now).toMatch(/min-width:\s*0/);
      const title = css.match(/\.miniplayer__title\s*\{([^}]*)\}/)?.[1] ?? '';
      expect(title).toMatch(/text-overflow:\s*ellipsis/);
    });

    it('볼륨 축은 슬라이더 아래 2행 그리드가 아니라 램프가 오른쪽에 붙는 한 줄 인라인이다', () => {
      const axis = css.match(/\.volume-axis\s*\{([^}]*)\}/)?.[1] ?? '';
      expect(axis).toMatch(/display:\s*flex/);
      expect(axis).not.toMatch(/grid-template-rows/);
      // 램프 fid는 그대로 — 조작 자동화·회귀 스냅샷이 이 이름에 걸려 있다
      const topbarSource = readFileSync(new URL('./control/topbar.ts', import.meta.url), 'utf8');
      expect(topbarSource).toContain('`volume-${axis}-ramp-${choice.id}`');
    });
  });
});
