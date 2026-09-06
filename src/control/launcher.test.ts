// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  activeTeamIds,
  createInitialState,
  getTeam,
  normalizeLauncherExtraScenes,
  reducer,
} from '../state';
import { versusPairOptions } from '../versus-pairs';
import { routeSceneActionsThroughDefaultTransition, sceneSetChange } from '../scene-routing';
import * as launcher from './launcher';

const css = readFileSync(new URL('../styles/control.css', import.meta.url), 'utf8');
const source = readFileSync(new URL('./launcher.ts', import.meta.url), 'utf8');
const controlSource = readFileSync(new URL('../control.ts', import.meta.url), 'utf8');

describe('씬 런처 사진 배경 퀵 토글', () => {
  const api = launcher as typeof launcher & {
    standbyBackdropQuickToggle: (
      settings: ReturnType<typeof createInitialState>['photos']['settings'],
    ) => { text: string; pressed: boolean };
  };

  it('색에 의존하지 않고 체크 표시와 켬·끔 텍스트로 현재 상태를 알린다', () => {
    const settings = createInitialState().photos.settings;

    expect(api.standbyBackdropQuickToggle(settings)).toEqual({
      text: '☐ 사진 배경 끔',
      pressed: false,
    });
    expect(api.standbyBackdropQuickToggle({ ...settings, standbyBackdrop: true })).toEqual({
      text: '☑ 사진 배경 켬',
      pressed: true,
    });
  });

  it('사전미션 뒤 씬 런처에서 대기 화면을 누르면 일반 대기영상 모드로 복귀한다', () => {
    expect((launcher as any).sceneEntryAction('standby')).toEqual({
      type: 'scene/set',
      scene: 'standby',
      opts: { standby: { mode: 'main' } },
    });
    // `score`도 U89에서 자기 정본(전체 보드)을 갖게 됐다 — opts가 붙지 않는 예는 `live`로 든다
    expect((launcher as any).sceneEntryAction('live')).toEqual({ type: 'scene/set', scene: 'live' });
  });
});

/**
 * U86 — 사용자 보고 "팀별 사전미션 상태에서 F1을 누르면 장면 전환 효과가 안 뜸".
 *
 * 원인은 액션을 만드는 곳이 둘이었다는 것이다. 런처 버튼은 목적지 모드를 실어 보냈고
 * `control.ts`의 F1은 맨몸 `scene/set`을 냈다. 씬 id가 둘 다 `standby`라 **모드만이 유일한
 * 차이**인데 그 모드가 액션에 없으면 `sceneSetChange()`가 "바뀌는 것이 없다"고 읽는다.
 */
describe('씬 진입 액션 빌더 (U86)', () => {
  it('F1 단축키가 런처 버튼과 같은 빌더를 쓴다 — 액션이 두 곳에서 갈리지 않는다', () => {
    // U131 — F2가 지금 오버레이가 퓨어인지 알아야 하므로 두 번째 인자로 state를 실어 보낸다.
    expect(controlSource).toContain(
      'function setScene(scene: SceneId): void {\n  dispatch(sceneEntryAction(scene, state.sceneOpts.liveOverlay));',
    );
    // 맨몸 `scene/set`으로 돌아가면 전환이 다시 조용히 빠진다
    expect(controlSource).not.toContain("dispatch({ type: 'scene/set', scene });");
    expect(controlSource).toContain(
      "import { pureCameraAction, renderLauncher, replayMarkLabel, sceneEntryAction } from './control/launcher';",
    );
  });

  it('대기 화면 진입은 언제나 메인 모드를 명시한다 — 나머지 씬은 opts가 붙지 않는다', () => {
    expect(launcher.sceneEntryAction('standby')).toEqual({
      type: 'scene/set',
      scene: 'standby',
      opts: { standby: { mode: 'main' } },
    });
    // `score`는 U89에서 자기 정본(전체 보드)을 갖게 됐다 — 아래 절에서 따로 본다
    for (const scene of ['live', 'timer', 'photos', 'roster', 'award'] as const) {
      expect(launcher.sceneEntryAction(scene)).toEqual({ type: 'scene/set', scene });
    }
  });

  /**
   * 빌더가 낸 액션을 라우터가 실제로 어떻게 읽는지까지 본다. 빌더의 모양만 잠그면
   * "opts는 붙는데 전환은 여전히 안 걸린다"를 놓친다 — 그게 바로 U86의 증상이었다.
   * (라우터 자체의 계약 검사는 `scene-routing.test.ts`의 U35 절이 계속 쥔다.)
   */
  it.each([
    ['pre-mission', 'standby-mode'],
    ['oath', 'standby-mode'],
    // 이미 메인 대기 화면이면 전환을 걸지 않는다 — 같은 화면 위로 스팅어를 반복하지 않는다
    ['main', null],
  ] as const)('%s 에서 F1을 누르면 sceneSetChange가 %s 로 읽는다', (from, expected) => {
    expect(sceneSetChange('standby', from, launcher.sceneEntryAction('standby'))).toBe(expected);
  });

  it('사전미션에서 F1이 만드는 액션은 실제로 스팅어를 입는다', () => {
    const state = createInitialState();
    state.assets = [
      {
        id: 'sting-default',
        name: '기본 알파 전환',
        type: 'video',
        size: 26_729,
        mime: 'video/webm',
        playMode: 'transition',
        switchAtSec: 0.65,
      },
    ];
    state.transitionRules = { defaultAssetId: 'sting-default', byTo: {}, pairs: [] };
    state.sceneOpts.standby = { mode: 'pre-mission' };

    expect(
      routeSceneActionsThroughDefaultTransition(state, [launcher.sceneEntryAction('standby')], 55),
    ).toEqual([
      {
        type: 'transition/play',
        assetId: 'sting-default',
        nextScene: 'standby',
        nextStandbyMode: 'main',
        switchAtSec: 0.65,
        now: 55,
      },
    ]);
  });

  /**
   * U89 — U86과 같은 뿌리의 두 번째 자리. `score`도 씬 하나에 두 얼굴이 있다:
   * `sceneOpts.score.highlight`가 `null`이면 전체 보드, 종목 id면 그 한 칸만 여는 공개 보드다.
   * 큐시트 `score-<종목>`이 박아 둔 id가 남아 있으면 F3가 전체 보드를 부르지 못한다.
   */
  it('스코어보드 진입은 언제나 전체 보드를 뜻한다 — 하이라이트를 명시적으로 비운다', () => {
    expect(launcher.sceneEntryAction('score')).toEqual({
      type: 'scene/set',
      scene: 'score',
      opts: { score: { highlight: null } },
    });
  });

  /**
   * 액션의 모양만 잠그면 "opts는 붙는데 상태는 그대로"를 놓친다. 같은 씬 위의 `scene/set`이라
   * 전환은 걸리지 않지만(`sceneSetChange` → `null`) 리듀서는 opts를 반드시 반영해야 한다 —
   * `mergeDeep`이 `null`을 "건너뛸 값"이 아니라 "쓸 값"으로 다루는지가 이 검사의 핵심이다.
   */
  it('종목 공개 뒤 F3를 누르면 하이라이트가 실제로 비워진다 (전환 없이 상태만)', () => {
    const revealed = reducer(createInitialState(), {
      type: 'scene/set',
      scene: 'score',
      opts: { score: { highlight: 'curling' } },
    });
    expect(revealed.sceneOpts.score.highlight).toBe('curling');

    const action = launcher.sceneEntryAction('score');
    // 씬이 그대로라 전환은 걸리지 않는다 — 액션이 손대지 않은 채로 리듀서까지 간다
    expect(sceneSetChange('score', 'main', action)).toBeNull();
    expect(routeSceneActionsThroughDefaultTransition(revealed, [action], 9)).toEqual([action]);

    expect(reducer(revealed, action).sceneOpts.score.highlight).toBeNull();
  });

  it('대기 화면에서 F3로 들어올 때도 하이라이트가 남지 않는다 (스팅어 경유)', () => {
    const state = createInitialState();
    state.assets = [
      {
        id: 'sting-default',
        name: '기본 알파 전환',
        type: 'video',
        size: 26_729,
        mime: 'video/webm',
        playMode: 'transition',
        switchAtSec: 0.65,
      },
    ];
    state.transitionRules = { defaultAssetId: 'sting-default', byTo: {}, pairs: [] };
    state.sceneOpts.score = { highlight: 'curling' };

    // 씬이 바뀌는 경로는 도착 씬의 opts를 스팅어가 덮기 전에 미리 반영한다(지금 보이는 화면은 대기라 드러나지 않는다)
    const routed = routeSceneActionsThroughDefaultTransition(
      state,
      [launcher.sceneEntryAction('score')],
      9,
    );
    expect(routed[0]).toEqual({ type: 'sceneOpts/patch', patch: { score: { highlight: null } } });

    const applied = routed.reduce(reducer, state);
    expect(applied.sceneOpts.score.highlight).toBeNull();
  });
});

describe('씬 런처 전환 스위처', () => {
  const api = launcher as typeof launcher & {
    launcherTransitionOptions: (mode: 'white' | 'black' | 'stinger') => {
      id: 'white' | 'black' | 'stinger';
      label: string;
      pressed: boolean;
    }[];
  };

  it('패널에 화이트·블랙·스팅어를 고정 순서로 표시하고 현재 모드를 알린다', () => {
    expect(api.launcherTransitionOptions('black')).toEqual([
      { id: 'white', label: '화이트', pressed: false },
      { id: 'black', label: '블랙', pressed: true },
      { id: 'stinger', label: '스팅어', pressed: false },
    ]);
  });
});

describe('씬 런처 대결팀 보더 (U14 · Split Color Tiles)', () => {
  it('확정 팀 수 4로 조합 6개를 씬 버튼 바로 아래에 만든다', () => {
    const state = createInitialState();

    expect(activeTeamIds(state)).toHaveLength(4);
    expect(versusPairOptions(activeTeamIds(state), null, (id) => getTeam(state, id))).toHaveLength(6);
    // 씬 그리드 다음, 리플레이 박스 앞
    expect(source.indexOf('versusBox(ctx)')).toBeGreaterThan(source.indexOf("class: 'launcher__grid'"));
    // U81 — 리플레이는 씬 그리드 안으로 올라갔고 대결 카드가 그 다음이다
    expect(source).not.toContain('replayBox(ctx)');
  });

  it('타일 절반씩 좌·우 팀 색 면을 깔고 색은 팀 설정 값을 그대로 읽는다', () => {
    expect(source).toContain('style: `--vs-l:${option.left.color};--vs-r:${option.right.color}`');
    expect(css).toContain('.vspair__face--l');
    expect(css).toContain('color-mix(in srgb, var(--vs-l) 26%, transparent)');
    expect(css).toContain('color-mix(in srgb, var(--vs-r) 26%, transparent)');
  });

  it('선택 상태를 색·형태·텍스트 셋으로 동시에 알린다', () => {
    const on = css.slice(css.indexOf('.vspair.is-on {'), css.indexOf('.vsbox__tools {'));

    expect(source).toContain("option.selected ? '✓ ON' : 'VS'");
    expect(source).toContain("attrs: { 'aria-pressed': option.selected ? 'true' : 'false' }");
    expect(on).toContain('border-color');
    expect(on).toContain('color-mix(in srgb, var(--vs-l) 46%, transparent)');
  });

  it('타일은 roving tabindex로 Tab 한 번에 들어오고 방향키로 옮긴다', () => {
    expect(source).toContain('tabIndex: index === entryIndex ? 0 : -1');
    expect(source).toContain('nextVersusFocus(ev.key, index, options.length)');
  });

  it('타일 위 Space는 전파만 끊는다 (전역 타이머 토글 차단 · 네이티브 활성화 보존)', () => {
    const handler = source.slice(source.indexOf('keydown: (ev) => {'), source.indexOf('focusAt(next);'));

    expect(handler).toContain("if (ev.code === 'Space') {");
    // Space 가지에서는 stopPropagation만 — preventDefault가 있으면 keyup 활성화가 죽는다
    const spaceBranch = handler.slice(handler.indexOf("if (ev.code === 'Space') {"), handler.indexOf('return;'));
    expect(spaceBranch).toContain('ev.stopPropagation()');
    expect(spaceBranch).not.toContain('preventDefault');
  });

  it('상태 칩 상세는 요약 라벨 되파싱 없이 팀을 직접 읽는다', () => {
    expect(source).toContain('tip: versusStatusTip(current, teamOf)');
    expect(source).not.toContain("status.split(' ↔ ')");
  });

  it('조합이 15개로 늘어도 런처를 세로로 밀지 않는다', () => {
    const pairs = css.slice(css.indexOf('.vsbox__pairs {'), css.indexOf('.vspair {'));

    expect(pairs).toContain('max-height');
    expect(pairs).toContain('overflow-y: auto');
  });

  it('좁은 열에서도 줄바꿈 없이 말줄임으로 접히고 양수 자간을 쓰지 않는다', () => {
    const tile = css.slice(css.indexOf('.vspair__name {'), css.indexOf('.vspair__name--l'));

    expect(tile).toContain('white-space: nowrap');
    expect(tile).toContain('text-overflow: ellipsis');
    expect(tile).toContain('letter-spacing: -0.01em');
    expect(css.slice(css.indexOf('.vsbox {'), css.indexOf('.launcher__photo-toggle'))).not.toMatch(
      /letter-spacing:\s*0?\.\d/,
    );
  });
});


/**
 * U49 — 런처의 `UNLOCKED · 별도 묶음` 퀵 카드를 걷어냈다.
 *
 * 해제하고 나면 그 카드가 런처 아래에 상시로 남아, 1부 내내 후반부 씬 버튼 세 개가 조작
 * 화면에 떠 있었다. 잠금의 뜻은 "그 화면을 아직 안 쓴다"인데 버튼이 손에 닿는 자리에 있으면
 * 오조작 거리가 0이다. 문자열 계약을 소스 스캔으로 고정한다.
 */
/**
 * 주석을 걷어낸 소스. 계약은 **화면에 나가는 문자열**에 대한 것이고, 왜 걷어냈는지를 적어 둔
 * 설명이 그 계약을 깨뜨리면 안 된다(실제로 이 파일의 첫 판이 자기 주석에 걸려 실패했다).
 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('후반부 퀵 카드 제거 (U49)', () => {
  const launcher = stripComments(readFileSync(new URL('./launcher.ts', import.meta.url), 'utf8'));
  const p2Tab = stripComments(readFileSync(new URL('./tab-p2.ts', import.meta.url), 'utf8'));

  it('런처에 후반부 씬 버튼·묶음 카드가 남아 있지 않다', () => {
    expect(launcher).not.toContain('별도 묶음');
    expect(launcher).not.toContain('launcher__locked');
    expect(launcher).not.toContain('P2_BUTTONS');
    for (const scene of ['breaking', 'suspects', 'submit']) {
      expect(launcher).not.toContain(`scene: '${scene}'`);
    }
  });

  it('[잠금 해제]는 런처에 남는다 — 잠긴 동안에는 후반 탭 자체가 비활성이다', () => {
    expect(launcher).toContain('잠금 해제');
    expect(launcher).toContain("requireText: 'OPEN'");
    expect(launcher).toContain("type: 'p2/unlock'");
    // 해제된 뒤에는 런처에 아무것도 남기지 않는다
    expect(launcher).toContain('locked ? unlockBtn : null');
  });

  it('[다시 잠그기]는 후반 탭에 있다', () => {
    expect(p2Tab).toContain('다시 잠그기');
    expect(p2Tab).toContain("type: 'p2/lock'");
    expect(launcher).not.toContain('다시 잠그기');
    expect(launcher).not.toContain("type: 'p2/lock'");
  });
});

/**
 * U57 — 대결 카드 접기. 접힌 상태는 저장본에 남는다(모듈 로컬 변수면 창을 열 때마다 펼쳐진다).
 * 출력 화면과 무관한 순수 조작 화면 설정이라 런타임 phase와 아무 관계가 없다.
 */
describe('대결 카드 접기 (U57)', () => {
  it('머리 전체가 aria-expanded를 든 토글 버튼이고 본문은 hidden으로 접힌다', () => {
    expect(source).toContain("class: 'vsbox__head vsbox__toggle'");
    expect(source).toContain("'aria-expanded': collapsed ? 'false' : 'true'");
    expect(source).toContain("class: 'vsbox__body'");
    expect(source).toContain("hidden: collapsed ? 'hidden' : undefined");
  });

  it('접힘 여부는 색만이 아니라 형태(▾/▸)로도 알리고 저장본에 남는다', () => {
    expect(source).toContain("text: collapsed ? '▸' : '▾'");
    expect(source).toContain('ctx.state.settings.launcherVersusCollapsed');
    expect(source).toContain('launcherVersusCollapsed: !collapsed');
  });

  it('접어 두어도 지금 나가는 조합은 머리 안 상태 칩으로 계속 보인다', () => {
    const head = source.slice(source.indexOf("class: 'vsbox__head vsbox__toggle'"), source.indexOf("class: 'vsbox__body'"));

    expect(head).toContain("fid: 'versus-status'");
    // 버튼 안에 또 포커스 대상을 두지 않는다 — 머리 버튼 하나만 Tab을 받는다
    expect(head).not.toContain('tabIndex: 0');
  });

  it('접히는 본문에는 타일과 [좌우 바꾸기]·[보더 끄기] 한 줄만 남는다', () => {
    const body = source.slice(source.indexOf("class: 'vsbox__body'"), source.indexOf('function replayControlState'));

    expect(body).toContain("class: 'vsbox__pairs'");
    expect(body).toContain('↔ 좌우 바꾸기');
    expect(body).toContain('보더 끄기');
  });

  it('CSS에 토글·본문 규칙이 있고 양수 자간을 쓰지 않는다', () => {
    const block = css.slice(css.indexOf('.vsbox__toggle {'), css.indexOf('.vsbox__pairs {'));

    expect(block).toContain('cursor: pointer');
    expect(block).toContain('.vsbox__caret');
    expect(block).toContain('.vsbox__body {');
    expect(block).not.toMatch(/letter-spacing:\s*0?\.\d/);
  });

  /**
   * U130 — 접기를 눌러도 본문이 그대로 보이던 결함의 회귀 테스트.
   *
   * `.vsbox__body { display: grid }`는 작성자(author) 스타일이라 브라우저 기본(UA) 규칙인
   * `[hidden] { display: none }`보다 우선순위가 높다 — 같은 특이도(0,1,0)라도 UA origin이
   * author origin에 진다. 그래서 `hidden` 속성만으로는 본문이 숨겨지지 않고, `is-collapsed`
   * 클래스가 붙고 `hidden` 속성도 정확히 세팅되는데도 화면에는 그대로 남는다.
   * `.tabbar__more[hidden]`(U78)과 같은 규율로 `.vsbox__body[hidden]`을 명시해야 한다.
   */
  it('본문 hidden 속성이 실제로 숨기도록 [hidden] 규칙을 명시로 다시 누른다 (U130)', () => {
    const block = css.slice(css.indexOf('.vsbox__body {'), css.indexOf('.vsbox.is-collapsed {'));

    expect(block).toContain('.vsbox__body[hidden] {');
    expect(block.slice(block.indexOf('.vsbox__body[hidden] {'))).toMatch(
      /\.vsbox__body\[hidden\]\s*\{\s*display:\s*none;\s*\}/,
    );
  });
});

/**
 * U63 — 타일 좌/우 절반 클릭. 어느 절반을 가리키는지 화면에서 보이지 않으면 운영자가
 * 어디를 눌렀는지 모르고, 실수로 송출에 매치 영상이 나간다.
 */
describe('대결 타일 좌·우 절반 (U63)', () => {
  it('가리키는 절반만 밝아지고 경계선이 상시로 보인다', () => {
    const block = css.slice(css.indexOf('.vspair__half {'), css.indexOf('.vspair__text {'));

    expect(block).toContain('.vspair__half--l');
    expect(block).toContain('.vspair__half--r');
    expect(block).toContain('border-left');
    expect(block).toContain('.vspair__half:hover');
    // 타일 전체가 밝아지면 경계가 안 보인다 — hover 규칙은 절반에만 걸린다
    expect(block).not.toContain('.vspair:hover .vspair__half');
    expect(block).not.toMatch(/letter-spacing:\s*0?\.\d/);
  });

  it('▶ 표식은 우측(재생) 절반 안에 있고 그 절반을 가리킬 때 같이 밝아진다', () => {
    expect(css).toContain('.vspair__half--r:hover ~ .vspair__vid');
    const vid = css.slice(css.indexOf('.vspair__vid {'), css.indexOf('.vspair__vid.is-on'));
    expect(vid).toContain('right: 5px');
  });

  it('절반 판정 면은 장식 span이라 roving tabindex를 건드리지 않는다', () => {
    const tile = source.slice(source.indexOf('options.forEach'), source.indexOf("class: 'vspair__text'"));

    expect(tile).toContain("el('span', { class: 'vspair__half vspair__half--l' })");
    expect(tile).toContain("el('span', { class: 'vspair__half vspair__half--r' })");
    expect(tile).toContain('tabIndex: index === entryIndex ? 0 : -1');
  });

  it('타일 툴팁이 좌·우 절반과 키보드 경로를 함께 설명한다', () => {
    const state = createInitialState();
    const [option] = versusPairOptions(activeTeamIds(state), null, (id) => getTeam(state, id));

    expect(option.tip).toContain('왼쪽');
    expect(option.tip).toContain('오른쪽');
  });
});

/**
 * U66 — 시상·현장사진·출전 명단·영상 재생 버튼을 런처에서 내린다. 넷 다 큐시트로 갈 수 있고
 * 사진은 F6도 살아 있어 손이 막히지 않는다. 설정 탭에서 개별로 되돌린다.
 */
describe('씬 런처 버튼 숨김 (U66)', () => {
  const api = launcher as typeof launcher & {
    launcherSceneButtons: (
      extras: Record<'roster' | 'video' | 'photos' | 'award', boolean>,
    ) => { scene: string; key?: string }[];
  };
  const settings = createInitialState().settings;

  it('기본 설정에서는 대기 화면·중계·스코어보드·타이머 넷만 남는다', () => {
    expect(api.launcherSceneButtons(settings.launcherExtraScenes).map((b) => b.scene)).toEqual([
      'standby',
      'live',
      'score',
      'timer',
    ]);
  });

  it('시상을 켜면 다섯 개가 되고 자리는 P1_BUTTONS 순서를 따른다', () => {
    const scenes = api
      .launcherSceneButtons({ ...settings.launcherExtraScenes, award: true })
      .map((b) => b.scene);

    expect(scenes).toHaveLength(5);
    expect(scenes).toEqual(['standby', 'live', 'score', 'timer', 'award']);
  });

  it('넷을 다 켜면 예전과 같은 여덟 개다', () => {
    const scenes = api
      .launcherSceneButtons({ roster: true, video: true, photos: true, award: true })
      .map((b) => b.scene);

    expect(scenes).toEqual([
      'standby',
      'live',
      'score',
      'timer',
      'roster',
      'video',
      'photos',
      'award',
    ]);
  });

  it('버튼을 내려도 F6(현장 사진) 단축키는 런처가 계속 광고한다', () => {
    const withPhotos = api.launcherSceneButtons({
      ...settings.launcherExtraScenes,
      photos: true,
    });

    expect(withPhotos.find((b) => b.scene === 'photos')?.key).toBe('F6');
  });

  it('저장본에 모르는 씬 키가 있어도 버리고, 빠진 키는 꺼짐으로 채운다', () => {
    const normalized = normalizeLauncherExtraScenes({ award: true, breaking: true, roster: 'yes' });

    // `roster: 'yes'`는 불린이 아니므로 켜지지 않는다 — `true`로 명시된 키만 켠다
    expect(normalized).toEqual({ roster: false, video: false, photos: false, award: true });
    expect(Object.keys(normalized).sort()).toEqual(['award', 'photos', 'roster', 'video']);
  });

  it('기본값은 넷 다 꺼짐이고 대결 카드는 펼친 채로 시작한다', () => {
    expect(settings.launcherExtraScenes).toEqual({
      roster: false,
      video: false,
      photos: false,
      award: false,
    });
    expect(settings.launcherVersusCollapsed).toBe(false);
  });
});

/**
 * U73 — 사진 배경 토글을 [대기 화면] 씬 버튼 바로 아래로 옮겼다. 이 조작이 뜻을 갖는 씬은
 * 대기 화면 하나뿐인데, 예전에는 런처 맨 아래 떨어져 있어 "무엇의 배경인가"가 안 읽혔다.
 */
describe('사진 배경 토글 위치 (U73)', () => {
  it('씬 그리드 안, 대기 화면 버튼 바로 다음 칸에 들어간다', () => {
    expect(source).toContain(
      "b.scene === 'standby'\n          ? [sceneButton(ctx, b, false), photoToggle]",
    );
    // 런처 맨 아래가 아니라 그리드 안이다 (U81에서 리플레이 박스 자체가 사라졌다)
    expect(source.indexOf('const photoToggle')).toBeLessThan(source.indexOf("class: 'launcher__grid'"));
  });

  it('대기 화면 버튼과 토글이 각각 한 줄을 통째로 써서 좁은 폭에서도 안 접힌다', () => {
    expect(source).toContain("{ scene: 'standby', key: 'F1', wide: true");
    expect(css.slice(css.indexOf('.scene-btn--wide {'), css.indexOf('.scene-btn__meta {'))).toContain(
      'grid-column: 1 / -1',
    );

    const toggle = css.slice(css.indexOf('.launcher__photo-toggle {'), css.indexOf('.launcher__photo-toggle:hover'));
    expect(toggle).toContain('grid-column: 1 / -1');
    expect(toggle).toContain('white-space: nowrap');
    expect(toggle).toContain('text-overflow: ellipsis');
    expect(toggle).not.toMatch(/letter-spacing:\s*0?\.\d/);
  });

  it('켬/끔은 체크 글자 + aria-pressed + is-on 색 셋으로 동시에 알린다', () => {
    expect(source).toContain("backdropToggle.pressed ? ' is-on' : ''");
    expect(source).toContain("'aria-pressed': backdropToggle.pressed ? 'true' : 'false'");
    expect(source).toContain('text: backdropToggle.text');
    // 툴팁이 "바로 위 대기 화면"이라는 관계를 말해 준다
    expect(source).toContain('바로 위 [대기 화면] 씬');
  });
});

describe('상단 미니 플레이어 (U49)', () => {
  const topbar = stripComments(readFileSync(new URL('./topbar.ts', import.meta.url), 'utf8'));

  it('곡이 걸려 있을 때만 그리고, 재생·정지·앞뒤·모드를 상단에 둔다', () => {
    expect(topbar).toContain('function musicMiniPlayer(');
    expect(topbar).toContain("if (!current) return null;");
    for (const mark of ['⏮', '⏹', '⏭']) expect(topbar).toContain(mark);
    expect(topbar).toContain('stepTrackId');
    expect(topbar).toContain('MUSIC_REPEAT_MARK');
  });

  it('곡 고르기와 스크럽은 상단에 두지 않는다 — 목록은 [음악] 탭이 답이다', () => {
    expect(topbar).not.toContain('MUSIC_TRACKS');
    expect(topbar).not.toContain('music-player__range');
  });

  /**
   * 리뷰 지적: ⏸가 `m.positionSec`(마지막 **명령** 위치)을 쓰면, 재생 중 한참 지난 뒤 여기서
   * 멈출 때 곡이 그 옛 자리로 되감긴다. 음악 탭의 [일시정지]와 같은 `livePosition()`을 써야
   * 두 버튼이 같은 자리를 찍는다.
   */
  it('일시정지는 지금 울리는 위치를 쓴다 — 낡은 명령 위치가 아니다', () => {
    expect(topbar).toContain("positionSec: livePosition(ctx).t");
    expect(topbar).not.toContain('positionSec: m.positionSec');
  });

  it('진행 시간은 200ms 라이브 슬롯을 재사용한다 (전체 재렌더 금지)', () => {
    expect(topbar).toContain("data: { live: 'music-time' }");
    expect(topbar).toContain("data: { live: 'music-duration' }");
  });
});

/**
 * U81 — 되감기 조작을 [경기 중계] 바로 오른쪽 칸으로 올린다.
 *
 * 씬 그리드가 `[대기 화면(전폭)] / [사진 배경 토글(전폭)] / [경기 중계][⏪ 리플레이] /
 * [스코어보드][타이머]`가 된다. 되감기는 중계 화면 조작이라 그 버튼 옆이 손이 가는 자리다.
 */
describe('리플레이 버튼 자리 (U81)', () => {
  it('경기 중계 다음 칸에 들어가고, 스코어보드·타이머가 한 줄 내려간다', () => {
    // U131 — [경기 중계] 칸 자체가 liveSceneButton으로 갈려(기본 크롬 | 퓨어) 자리는 그대로다.
    expect(source).toContain(
      "b.scene === 'live'\n            ? [liveSceneButton(ctx, b), replayButton(ctx)]",
    );
    // 순서의 정본은 그대로 P1_BUTTONS다 — 리플레이는 씬이 아니라 끼어드는 조작이다
    const order = launcher.launcherSceneButtons({ roster: false, video: false, photos: false, award: false });
    expect(order.map((b) => b.scene)).toEqual(['standby', 'live', 'score', 'timer']);
  });

  it('버퍼 칩이 버튼 안에 있고 R 키캡을 함께 단다', () => {
    expect(source).toContain("class: `scene-btn__buffer${bufferedSec >= 1 ? ' is-on' : ''}`");
    expect(source).toContain("el('span', { class: 'scene-btn__key mono-label', text: 'R' })");
    // 라벨에서는 (R)을 뺐다 — 키캡이 따로 붙으므로 두 번 말하지 않는다
    expect(source).toContain("const label = '⏪ 리플레이';");
  });

  it('씬 버튼과 같은 골격을 써서 칸 크기가 저절로 맞는다', () => {
    expect(source).toContain(
      "class: `scene-btn scene-btn--replay scene-btn--half${view.disabled ? ' is-off' : ' is-ready'}`",
    );
    expect(css).toMatch(/\.scene-btn--replay\.is-ready\s*\{/);
    expect(css).toMatch(/\.scene-btn--replay\.is-off\s*\{/);
    expect(css).toMatch(/\.scene-btn__buffer\s*\{/);
  });

  /**
   * `disabled`를 쓰면 (1) 안에 든 버퍼 칩 툴팁이 hover·focus 어느 쪽으로도 안 열리고
   * (2) 눌러도 아무 일이 없어 이유를 알 수 없다. 단축키 `R`과 같은 입구를 타게 해서
   * 거절 사유를 토스트로 말한다.
   */
  it('못 누르는 상태를 disabled가 아니라 aria-disabled로 알린다', () => {
    const fn = source.slice(source.indexOf('function replayButton'), source.indexOf('export function launcherSceneButtons'));
    expect(fn).toContain("'aria-disabled': view.disabled ? 'true' : 'false'");
    expect(fn).not.toContain('disabled: view.disabled');
    expect(fn).toContain('ctx.toggleReplay()');
  });

  it('옛 별도 박스는 마크업도 CSS도 남지 않는다', () => {
    expect(source).not.toContain("class: 'replaybox'");
    expect(source).not.toContain('replaybox__btn');
    expect(css).not.toContain('.replaybox');
  });
});

/**
 * U85 — 한 칸 안에서 반으로 갈린 리플레이 버튼.
 *
 * 사용자 원문: "버튼을 반으로 쪼개고 '지금부터' 버튼을 만들어줘. 그걸 누르면 누른 시점
 * 1초 전부터 메모리에 담겨서 그 구간만큼만 재생되도록."
 */
describe('리플레이 반쪽 분할 (U85)', () => {
  const READY = {
    playing: false,
    scene: 'live',
    enabled: true,
    bufferedSec: 10,
    markAt: null as number | null,
    now: 1_000_000,
    rate: 0.1,
  };

  it('찍은 것이 없으면 [지금부터], 찍어 두면 [여기까지] + 자라는 초', () => {
    const idle = launcher.replayMarkControlState(READY);
    expect(idle.label).toBe('⏺ 지금부터');
    expect(idle.mark).toBeNull();
    expect(idle.disabled).toBe(false);

    const marked = launcher.replayMarkControlState({ ...READY, markAt: READY.now - 4_300 });
    expect(marked.label).toBe('▶ 여기까지');
    expect(marked.mark).toBe('4초');
    expect(marked.disabled).toBe(false);
  });

  it('재생 중에는 어느 반쪽을 눌러도 멈춘다 — 두 반쪽이 같은 라벨을 보인다', () => {
    const playing = { ...READY, playing: true, markAt: READY.now - 4_000 };
    expect(launcher.replayMarkControlState(playing).label).toBe('■ 라이브 복귀');
    expect(
      launcher.replayControlState({
        playing: true,
        scene: 'live',
        enabled: true,
        bufferedSec: 10,
        replaySec: 10,
        rate: 0.1,
      }).label,
    ).toBe('■ 라이브 복귀');
  });

  /**
   * 지금 버퍼가 비었어도 그것은 "몇 초 뒤에는 찬다"는 뜻이다. 시작점을 못 찍게 막으면
   * 정작 담고 싶은 장면의 앞머리를 놓친다 — 되감을 것이 있는지는 두 번째 누름에서 따진다.
   */
  it('찍는 단계는 버퍼를 따지지 않고, 되감는 단계에서만 따진다', () => {
    const empty = { ...READY, bufferedSec: 0 };
    expect(launcher.replayMarkControlState(empty).disabled).toBe(false);
    expect(
      launcher.replayMarkControlState({ ...empty, markAt: READY.now - 4_000 }).disabled,
    ).toBe(true);
  });

  it.each([
    ['중계 화면이 아니면', { scene: 'score' }, '중계 화면'],
    ['설정이 꺼져 있으면', { enabled: false }, '꺼져 있습니다'],
  ])('%s 비활성이고 이유를 툴팁에 적는다', (_label, patch, reason) => {
    const view = launcher.replayMarkControlState({ ...READY, ...patch });
    expect(view.disabled).toBe(true);
    expect(view.tip).toContain(reason);
  });

  it('되감는 단계의 툴팁은 클램프·취소·단축키를 그 자리에서 말한다', () => {
    const view = launcher.replayMarkControlState({ ...READY, markAt: READY.now - 4_000 });
    expect(view.tip).toContain('있는 만큼만');
    expect(view.tip).toContain('Shift+클릭');
    expect(view.tip).toContain('Shift+R');
    // 배속 표기는 배지·상단 칩과 같은 포맷터를 쓴다
    expect(view.tip).toContain('0.1배속');
  });

  /**
   * 200ms 갱신에서 소수를 보이면 `4.3초 → 4.5초`가 떨리게 읽힌다. 재생에 쓰는 값은
   * 반올림하지 않은 실측 그대로다(`control.ts`) — 화면 표기만 정수다.
   */
  it('초 표시는 정수로 반올림하고 1초 아래로 내려가지 않는다', () => {
    expect(launcher.replayMarkLabel(1_000)).toBe('1초');
    expect(launcher.replayMarkLabel(4_300)).toBe('4초');
    expect(launcher.replayMarkLabel(4_700)).toBe('5초');
    expect(launcher.replayMarkLabel(0)).toBe('1초');
  });

  it('두 반쪽이 한 칸 안에 있고, DOM 순서가 왼쪽 → 오른쪽이라 Tab이 보이는 대로 돈다', () => {
    const fn = source.slice(
      source.indexOf('function replayButton'),
      // U131 — liveSceneButton이 replayButton과 launcherSceneButtons 사이에 새로 끼어들었다.
      source.indexOf('function liveSceneButton'),
    );
    expect(fn).toContain("el('div', { class: 'scene-btn-split' }, left, right)");
    expect(fn.indexOf('const left =')).toBeLessThan(fn.indexOf('const right ='));
    // 두 반쪽 다 진짜 버튼이다 — div에 클릭만 붙이면 키보드로 못 누른다
    expect(fn.match(/el\(\s*'button'/g)?.length).toBe(2);
  });

  it('오른쪽 반쪽은 Shift+클릭이면 취소, 아니면 토글이다', () => {
    const fn = source.slice(
      source.indexOf('function replayButton'),
      // U131 — liveSceneButton이 replayButton과 launcherSceneButtons 사이에 새로 끼어들었다.
      source.indexOf('function liveSceneButton'),
    );
    expect(fn).toContain('ev.shiftKey ? ctx.clearReplayMark() : ctx.toggleReplayMark()');
    expect(fn).toContain("text: '⇧R'");
  });

  it('자라는 초는 별도 노드에 담아 200ms마다 텍스트만 갈아 끼운다 (전체 재렌더 금지)', () => {
    expect(source).toContain("data: { live: 'replay-mark' }");
    expect(controlSource).toContain('function paintReplayMark(');
    expect(controlSource).toContain("querySelectorAll<HTMLElement>('[data-live=\"replay-mark\"]')");
    expect(controlSource).toContain('paintReplayMark(now)');
  });

  it('JS가 만드는 분할 클래스는 전부 CSS 규칙을 가진다', () => {
    for (const cls of ['scene-btn-split', 'scene-btn--half', 'scene-btn--mark', 'scene-btn__mark']) {
      expect(source).toContain(cls);
      expect(css).toContain(`.${cls}`);
    }
    expect(css).toMatch(/\.scene-btn--mark\.is-marked\s*\{/);
  });
});

/**
 * U131 — 사용자 지시(2026-09-05 11:3x): "중계 오버레이 다 끄고 완전 퓨어 카메라로 보이는
 * 옵션도 만들어줘." [경기 중계] 칸이 [기본 크롬 | 퓨어] 반쪽 분할로 갈리고, 퓨어 상태에서
 * [경기 중계]를 다시 누르면 크롬이 돌아온다.
 */
describe('퓨어 카메라 (U131)', () => {
  const chrome = createInitialState().sceneOpts.liveOverlay;
  const pure = { ...chrome, scorebar: false, timer: false, badge: null, versus: null, frame: 'none' as const };

  it('pureCameraAction은 live-frame의 liveOverlayAllOff(none)을 그대로 싣는다', () => {
    expect(launcher.pureCameraAction()).toEqual({
      type: 'scene/set',
      scene: 'live',
      opts: {
        liveOverlay: { scorebar: false, timer: false, badge: null, versus: null, frame: 'none' },
      },
    });
  });

  it('평소(퓨어가 아닐 때)는 F2가 예전 그대로 오버레이를 건드리지 않는다', () => {
    // 인자를 생략한 기존 호출부(다른 씬·기존 테스트)와 정확히 같은 모양이어야 한다
    expect(launcher.sceneEntryAction('live')).toEqual({ type: 'scene/set', scene: 'live' });
    expect(launcher.sceneEntryAction('live', chrome)).toEqual({ type: 'scene/set', scene: 'live' });
    // 배지·대결 보더가 켜진 채(1부 종목 중계 중)여도 F2는 그것을 지우지 않는다
    const midEvent = { ...chrome, badge: 'curling' as const, versus: null };
    expect(launcher.sceneEntryAction('live', midEvent)).toEqual({ type: 'scene/set', scene: 'live' });
  });

  it('퓨어 상태에서 F2를 누르면 기본 크롬(스코어바·타이머)으로만 복귀한다', () => {
    expect(launcher.sceneEntryAction('live', pure)).toEqual({
      type: 'scene/set',
      scene: 'live',
      opts: { liveOverlay: { scorebar: true, timer: true } },
    });
  });

  it('런처 격자 — [경기 중계] 칸이 liveSceneButton으로 기본 크롬·퓨어 반쪽으로 갈린다', () => {
    const fn = source.slice(
      source.indexOf('function liveSceneButton'),
      source.indexOf('/**\n * 지금 런처에 그릴 씬 버튼'),
    );
    expect(fn).toContain("el('div', { class: 'scene-btn-split' }, chrome, pureBtn)");
    // 왼쪽은 sceneEntryAction('live', overlay) — 같은 빌더를 그대로 쓴다 (U86 계약 유지)
    expect(fn).toContain("ctx.dispatch(sceneEntryAction('live', overlay))");
    // 오른쪽은 pureCameraAction() — 단축키는 Shift+F2
    expect(fn).toContain('ctx.dispatch(pureCameraAction())');
    expect(fn).toContain("text: 'F2'");
    expect(fn).toContain("text: '⇧F2'");
    expect(fn).toContain("text: '퓨어'");
    // 두 반쪽 다 진짜 버튼이다 (Tab으로 눌러야 하니까)
    expect(fn.match(/el\(\s*'button'/g)?.length).toBe(2);
  });

  it('큐시트 part2-live와 같은 liveOverlayAllOff() 빌더를 공유한다 — frame만 다르다', () => {
    expect(source).toContain("liveOverlayAllOff('none')");
    const cueSource = readFileSync(new URL('../cue.ts', import.meta.url), 'utf8');
    expect(cueSource).toContain("liveOverlayAllOff('dark-standby')");
  });

  it('F2·Shift+F2 단축키가 런처 버튼과 같은 빌더를 쓴다', () => {
    expect(controlSource).toContain("F2: () => setScene('live'),");
    expect(controlSource).toContain("'Shift+F2': () => dispatch(pureCameraAction()),");
  });

  it('상단 바 ON AIR 라벨이 퓨어일 때 · 퓨어를 붙인다', () => {
    const topbarSource = readFileSync(new URL('./topbar.ts', import.meta.url), 'utf8');
    expect(topbarSource).toContain(
      "effective === 'live' && isPureCameraOverlay(s.sceneOpts.liveOverlay)",
    );
    expect(topbarSource).toContain('`${SCENE_LABELS[effective]} · 퓨어`');
  });
});
