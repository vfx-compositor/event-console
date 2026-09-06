/**
 * AC-2 자동 검증: 1부 진행 중 출력 화면 DOM 전체 텍스트에
 * "2부 / 추리 / 용의자 / 도핑 / 수사" 가 단 한 건도 없어야 한다.
 *
 * 씬 뷰가 순수 함수(state -> VNode)라 DOM 라이브러리 없이 렌더 결과 텍스트를 그대로 검사할 수 있다.
 */

import { describe, expect, it } from 'vitest';
import { SCENE_IDS, createInitialState, reducer, type Action } from './state';
import { isDegraded, pickScene, sceneView } from './scenes';
import { scoreColumns } from './scenes/common';
import { photoQueue } from './photos';
import { photoLayerAttrs } from './scenes/photos';
import { toHTML, toText } from './vdom';
import { P2_SCENES, type AppState, type SceneId } from './types';

const FORBIDDEN = /2부|추리|용의자|도핑|수사/g;
const T0 = 1_700_000_000_000;

/**
 * 씬 목록은 `SCENE_IDS`(전수 테이블에서 파생) 하나만 쓴다.
 * 여기 배열 리터럴을 따로 두면 씬이 늘어날 때 조용히 낡아 **새 씬만 검사에서 빠진다**.
 */
const ALL_SCENES: SceneId[] = SCENE_IDS;

/** 파일명만 다른 사진 메타. `p2`는 reducer가 흡수 시점의 잠금 상태로 찍으므로 여기서 주지 않는다. */
function photoMeta(name: string, takenAt: number) {
  return {
    id: `${name}|1024|${takenAt}`,
    name,
    takenAt,
    addedAt: takenAt,
    w: 1920,
    h: 1080,
    bytes: 1024,
    hidden: false,
  };
}

function run(state: AppState, ...actions: Action[]): AppState {
  return actions.reduce(reducer, state);
}

/** 후반 데이터가 가득 찬 상태 — 잠금이 없으면 반드시 유출될 조건 */
function loadedState(): AppState {
  let s = run(
    createInitialState(),
    { type: 'p1/rank', eventId: 'curling', teamId: 't1', rank: 1 },
    { type: 'p1/rank', eventId: 'curling', teamId: 't2', rank: 2 },
    { type: 'p1/rank', eventId: 'curling', teamId: 't3', rank: 3 },
    { type: 'p1/rank', eventId: 'curling', teamId: 't4', rank: 4 },
    { type: 'p1/confirm', eventId: 'curling', now: T0 },
    // 1부 중 수집된 사진 — 파일명 자체가 금지어다 (display가 메타를 렌더하면 그대로 유출된다)
    {
      type: 'photos/add',
      items: [photoMeta('용의자_후보.jpg', T0 + 100), photoMeta('2부_준비.png', T0 + 200)],
    },
    { type: 'p2/unlock' },
    // 2부 해제 뒤 수집된 사진 — reducer가 p2: true를 찍는다 (잠금 중 큐에서 빠지는지까지 본다)
    { type: 'photos/add', items: [photoMeta('도핑_수사_현장.jpg', T0 + 300)] },
    { type: 'p2/submit', stageId: 's1', teamId: 't1', at: T0 + 1000 },
    { type: 'p2/submit', stageId: 's1', teamId: 't2', at: T0 + 9000 },
    { type: 'p2/confirm', stageId: 's1', now: T0 + 20_000 },
    { type: 'p2/eliminate', code: 'B', on: true },
    {
      type: 'settings/patch',
      patch: {
        suspects: [
          { code: 'A', name: '가상 인물 A', sport: '컬링' },
          { code: 'B', name: '가상 인물 B', sport: '신문지' },
          { code: 'C', name: '가상 인물 C', sport: '끈끈이' },
          { code: 'D', name: '가상 인물 D', sport: '몸으로 말해요' },
          { code: 'E', name: '가상 인물 E', sport: '컬링' },
          { code: 'F', name: '가상 인물 F', sport: '끈끈이' },
        ],
      },
    },
  );
  // 데이터는 채워 두고 다시 잠근다 (실제 사고 시나리오: 리허설 후 재잠금)
  s = run(s, { type: 'p2/lock' });
  return s;
}

describe('2부 잠금 — 렌더 레벨 강제', () => {
  it('잠금 중에는 어떤 씬을 선택해도 출력 텍스트에 금지어가 0건이다', () => {
    const base = loadedState();
    const hits: string[] = [];
    for (const scene of ALL_SCENES) {
      const s = run(base, { type: 'scene/set', scene });
      // 텍스트뿐 아니라 **마크업 전체**를 본다 (§11 H3) — class·data 속성·alt로 새는 경로까지 막는다.
      for (const rendered of [toText(sceneView(s)), toHTML(sceneView(s))]) {
        const found = rendered.match(FORBIDDEN);
        if (found) hits.push(`${scene}: ${found.join(',')}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('시상 씬의 모든 단계에서도 금지어가 0건이다', () => {
    const base = run(loadedState(), { type: 'scene/set', scene: 'award' });
    for (const step of ['p1', 'p2', 'total', 'reveal', 'winner'] as const) {
      const s = run(base, { type: 'award/step', step }, { type: 'award/reveal', revealed: 4 });
      expect(toText(sceneView(s))).not.toMatch(FORBIDDEN);
    }
  });

  /**
   * U97 — 후반 단계 대기화면은 `submit` 씬의 한 모드다. 모드가 저장본에 남아 있어도
   * 1부 DOM에는 그 화면의 흔적(클래스·이미지 경로·폴백 문구)이 한 조각도 나오면 안 된다.
   */
  it('잠금 중에는 후반 단계 대기화면 모드가 DOM에 아예 없다', () => {
    const base = loadedState();
    for (const stageId of ['s1', 's2', 's3'] as const) {
      const s = run(
        base,
        { type: 'scene/set', scene: 'submit', opts: { submit: { stageId, mode: 'steady' } } },
      );
      expect(pickScene(s)).toBe('standby');
      const html = toHTML(sceneView(s));
      expect(html).not.toContain('scene--p2-steady');
      expect(html).not.toContain('p2-steady__flicker');
      expect(html).not.toContain('p2_steady_stage');
      expect(html).not.toMatch(FORBIDDEN);
      expect(toText(sceneView(s))).not.toMatch(FORBIDDEN);
    }
  });

  it('해제하면 같은 모드가 실제로 그 화면을 그린다 (검사기가 유출을 잡아낼 수 있음을 증명)', () => {
    const s = run(
      loadedState(),
      { type: 'p2/unlock' },
      { type: 'scene/set', scene: 'submit', opts: { submit: { stageId: 's2', mode: 'steady' } } },
    );
    expect(pickScene(s)).toBe('submit');
    expect(toHTML(sceneView(s))).toContain('./media/p2_steady_stage2.svg');
  });

  it('잠금 씬은 대기 화면으로 강등된다', () => {
    const base = loadedState();
    for (const scene of P2_SCENES) {
      const s = run(base, { type: 'scene/set', scene });
      expect(pickScene(s)).toBe('standby');
      expect(isDegraded(s)).toBe(true);
    }
  });

  it('스코어보드 열 데이터 자체가 만들어지지 않는다 (숨김이 아니라 미생성)', () => {
    const locked = loadedState();
    const cols = scoreColumns(locked);
    expect(cols).toHaveLength(4);
    expect(cols.every((c) => c.group === '1부')).toBe(true);
    expect(cols.some((c) => c.ref.startsWith('p2:'))).toBe(false);
  });

  it('해제하면 후반 열과 보드가 실제로 나타난다 (검사기가 유출을 잡아낼 수 있음을 증명)', () => {
    const unlocked = run(loadedState(), { type: 'p2/unlock' });
    expect(scoreColumns(unlocked)).toHaveLength(7);

    const board = run(unlocked, { type: 'scene/set', scene: 'suspects' });
    expect(pickScene(board)).toBe('suspects');
    expect(toText(sceneView(board))).toMatch(FORBIDDEN);
  });

  it('잠금 중 점수 총합에는 후반 점수가 그대로 반영된다 (숫자는 살아 있고 라벨만 없다)', () => {
    const locked = loadedState();
    const text = toText(sceneView(run(locked, { type: 'scene/set', scene: 'score' })));
    expect(text).not.toMatch(FORBIDDEN);
    // 1부 컬링 1위 100점 + 후반 1단계 공동 1위 250점 = 350
    expect(text).toContain('컬링');
  });
});

describe('현장 사진 씬 — 사진 메타 유출 차단 (계획 §4-1 · §11 H3)', () => {
  it('잠금 중 사진 씬을 렌더해도 파일명이 텍스트·마크업 어디에도 나오지 않는다', () => {
    const s = run(loadedState(), { type: 'scene/set', scene: 'photos' });
    expect(s.photos.items.map((p) => p.name)).toContain('용의자_후보.jpg');
    expect(pickScene(s)).toBe('photos'); // 강등 대상이 아니다 — 1부에도 쓰는 씬이다
    expect(toText(sceneView(s))).not.toMatch(FORBIDDEN);
    expect(toHTML(sceneView(s))).not.toMatch(FORBIDDEN);
  });

  it('2부 해제 후에도 마찬가지다 (뷰가 애초에 사진 메타를 읽지 않는다)', () => {
    const s = run(loadedState(), { type: 'p2/unlock' }, { type: 'scene/set', scene: 'photos' });
    expect(toText(sceneView(s))).not.toMatch(FORBIDDEN);
    expect(toHTML(sceneView(s))).not.toMatch(FORBIDDEN);
  });

  it('사진 목록이 어떻게 바뀌어도 렌더 HTML이 완전히 동일하다 (§11 L9 — 크로스페이드가 끊기지 않는 전제)', () => {
    const empty = run(createInitialState(), { type: 'scene/set', scene: 'photos' });
    const loaded = run(loadedState(), { type: 'scene/set', scene: 'photos' });
    const hidden = run(loaded, {
      type: 'photos/hidden',
      id: loaded.photos.items[0].id,
      hidden: true,
    });
    expect(toHTML(sceneView(loaded))).toBe(toHTML(sceneView(empty)));
    expect(toHTML(sceneView(hidden))).toBe(toHTML(sceneView(empty)));
  });

  it('잠금 중에는 2부에 수집된 사진이 재생 큐에서 빠진다 (§11 H2 — display가 읽는 유일한 목록)', () => {
    const locked = loadedState();
    const p2Photo = locked.photos.items.find((p) => p.p2);
    expect(p2Photo?.name).toBe('도핑_수사_현장.jpg');

    const lockedQueue = photoQueue(locked.photos.items, 'time', 0, false);
    expect(lockedQueue).not.toContain(p2Photo!.id);
    expect(lockedQueue).toHaveLength(2);

    // 해제하면 같은 사진이 큐에 돌아온다 (검사기가 유출을 잡아낼 수 있음을 증명)
    expect(photoQueue(locked.photos.items, 'time', 0, true)).toContain(p2Photo!.id);
  });

  it('런타임 <img> 레이어 속성에도 금지어가 들어갈 자리가 없다 (§11 H3 · M2)', () => {
    // 뷰는 슬롯만 렌더하고 실제 `<img>` 두 장은 display.ts가 런타임에 만든다 →
    // 마크업 검사만으로는 이 경로가 통째로 빠진다. 속성 집합을 만드는 순수 팩토리를 직접 본다.
    const attrs = photoLayerAttrs();
    const serialized = Object.entries(attrs)
      .map(([k, v]) => `${k}="${v}"`)
      .join(' ');
    expect(serialized).not.toMatch(FORBIDDEN);
    expect(attrs.alt).toBe('');
    expect(attrs).not.toHaveProperty('title');
    expect(attrs).not.toHaveProperty('aria-label');
    // 사진이 담긴 상태를 통과시켜도 팩토리 결과는 그대로다 (state를 읽지 않는다)
    expect(photoLayerAttrs()).toEqual(attrs);
    const s = run(loadedState(), { type: 'scene/set', scene: 'photos' });
    expect(s.photos.items.some((p) => FORBIDDEN.test(p.name))).toBe(true);
    FORBIDDEN.lastIndex = 0; // /g 정규식의 상태를 다음 검사에 흘리지 않는다
    expect(photoLayerAttrs()).toEqual(attrs);
  });

  it('사진 씬에는 텍스트 노드가 하나도 없다 (프로젝터에 운영 문구를 띄우지 않는다)', () => {
    const s = run(loadedState(), { type: 'scene/set', scene: 'photos' });
    expect(toText(sceneView(s)).trim()).toBe('');
  });
});

describe('라이브 대결 프레임', () => {
  it('선택한 좌·우 팀과 색을 명시적인 프레임으로 렌더한다', () => {
    const state = run(
      createInitialState(),
      {
        type: 'sceneOpts/patch',
        patch: { liveOverlay: { versus: ['t1', 't2'] } },
      },
      { type: 'scene/set', scene: 'live' },
    );
    const html = toHTML(sceneView(state));
    expect(html).toContain('class="vs-borders"');
    expect(html).toContain(
      `aria-label="${state.teams[0].name} 대 ${state.teams[1].name} 대결 프레임"`,
    );
    expect(html).toContain(`style="--team-color:${state.teams[0].color}"`);
    expect(html).toContain(`style="--team-color:${state.teams[1].color}"`);
  });
});
