// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { createInitialState, migrate, P1_EVENT_NAMES, P1_EVENT_ORDER, reducer } from '../state';
import { sceneView } from './index';
import { GAME_STEADY_IMAGES } from './game';
import { toHTML } from '../vdom';

function gameState(eventId: (typeof P1_EVENT_ORDER)[number], mode: 'opening' | 'standby') {
  return reducer(createInitialState(), {
    type: 'scene/set',
    scene: 'game',
    opts: { game: { eventId, mode } },
  });
}

describe('게임 오프닝·대기 화면', () => {
  it.each(P1_EVENT_ORDER)('%s 오프닝은 종목명과 GAME OPENING만 관객 화면에 표시한다', (eventId) => {
    const html = toHTML(sceneView(gameState(eventId, 'opening')));
    expect(html).toContain('scene--game-opening');
    expect(html).toContain(P1_EVENT_NAMES[eventId]);
    expect(html).toContain('GAME OPENING');
    expect(html).not.toContain('잠시 후 시작합니다');
  });

  it.each([
    ['curling', './media/game_steady_curling.svg'],
    ['newspaper', './media/game_steady_newspaper.svg'],
    ['sticky', './media/game_steady_sticky.svg'],
    ['sync', './media/game_steady_sync.svg'],
  ] as const)('%s 대기화면은 그 종목의 고정 이미지 한 장만 표시한다 (U29)', (eventId, src) => {
    const html = toHTML(sceneView(gameState(eventId, 'standby')));
    expect(html).toContain('scene--game-steady');
    expect(html).toContain(`src="${src}"`);
    expect(html).toContain(`data-event="${eventId}"`);
    // 이미지 한 장뿐 — 대기 영상·사진 슬롯·스코어바·타이틀 카드가 섞이면 안 된다
    expect(html).not.toMatch(/<video|photo-stage|photo-backdrop|data-photo-slot|standby-stack/);
    expect(html).not.toContain('main_05_light.webm');
    expect(html).not.toContain('main_05_dark.webm');
    expect(html).not.toContain(P1_EVENT_NAMES[eventId]);
    expect(html).not.toContain('game__card');
    expect(html).not.toContain('잠시 후 시작합니다');
    expect(html).not.toContain('GAME OPENING');
  });

  it('종목마다 서로 다른 이미지를 쓴다 (매핑 뒤섞임 방지)', () => {
    const srcs = P1_EVENT_ORDER.map((id) => GAME_STEADY_IMAGES[id]);
    expect(new Set(srcs).size).toBe(P1_EVENT_ORDER.length);
  });

  it('사진 배경을 켜도 게임 대기화면은 이미지 한 장 그대로다', () => {
    const state = gameState('curling', 'standby');
    state.photos.settings.standbyBackdrop = true;
    const html = toHTML(sceneView(state));
    expect(html).toContain('./media/game_steady_curling.svg');
    expect(html).not.toContain('data-photo-slot=""');
    expect(html).not.toContain('main_05_dark.webm');
  });

  it('사전미션 직후 진입해도 게임 대기화면은 사전미션 JPEG를 재사용하지 않는다', () => {
    const state = gameState('curling', 'standby');
    state.sceneOpts.standby.mode = 'pre-mission';
    const html = toHTML(sceneView(state));
    expect(html).toContain('./media/game_steady_curling.svg');
    expect(html).not.toContain('pre_mission.svg');
  });

  it('종목 id가 낡아 매핑이 없으면 검정 대신 전체 대기 영상으로 떨어진다', () => {
    const state = gameState('curling', 'standby');
    (state.sceneOpts.game as { eventId: string }).eventId = 'legacy-relay';
    const html = toHTML(sceneView(state));
    expect(html).toContain('scene--standby-video');
    expect(html).toContain('poster="./media/standby-light.svg"');
    expect(html).not.toContain('game-steady-image');
  });

  it('display는 부팅 때 네 장을 미리 받아 둔다 (소개 영상 → 대기 전환 검정 방지)', () => {
    const display = readFileSync(new URL('../display.ts', import.meta.url), 'utf8');
    expect(display).toContain("import { GAME_STEADY_IMAGES } from './scenes/game';");
    expect(display).toContain('for (const src of Object.values(GAME_STEADY_IMAGES)) {');
    expect(display).toContain('warm.src = src;');
  });

  it('JS가 붙이는 클래스에 대응 CSS 규칙이 있다', () => {
    const css = readFileSync(new URL('../styles/display.css', import.meta.url), 'utf8');
    for (const name of ['game-steady-image', 'scene--game-steady']) {
      expect(css).toContain(`.${name}`);
    }
  });
});

/**
 * U110 (2026-09-05 04:56 사용자 지시) — "송출보드 저건 폐기해. 내가 준 영상과 음악으로
 * 대체하고." 승리 팀 보드(U71)는 씬에서 사라졌다. 승리 발표는 이제 `winner_<색>.webm`
 * 알파 오버레이 + 승리 음악이고, 그 계약은 `cue.test.ts`가 잠근다.
 *
 * 여기서는 **카드가 정말 없는지**만 확인한다 — 씬·마크업·CSS 어디에도 남지 않아야 한다.
 */
describe('승리 팀 보드 폐기 (U110)', () => {
  it('저장본에 남은 `victory` 모드는 migrate가 대기로 접는다 — 씬에 도달하지 않는다', () => {
    // display는 모든 상태 방송을 `deserialize()` → `migrate()`로 받으므로 이 자리가 정본이다
    const saved = gameState('newspaper', 'opening');
    (saved.sceneOpts.game as { mode: string }).mode = 'victory';
    const state = migrate(JSON.parse(JSON.stringify(saved)));
    expect(state.sceneOpts.game.mode).toBe('standby');
    const html = toHTML(sceneView(state));
    expect(html).toContain('scene--game-steady');
    expect(html).toContain('./media/game_steady_newspaper.svg');
    expect(html).not.toContain('scene--game-victory');
    expect(html).not.toContain('WINNER');
  });

  it('승리 카드 마크업이 어느 모드에서도 나오지 않는다', () => {
    for (const mode of ['opening', 'standby'] as const) {
      for (const eventId of P1_EVENT_ORDER) {
        const html = toHTML(sceneView(gameState(eventId, mode)));
        for (const mark of ['victory__', 'game__card--victory', 'scene--game-victory', 'WINNER']) {
          expect(html, `${eventId}/${mode}에 ${mark}`).not.toContain(mark);
        }
      }
    }
  });

  it('마크업이 사라진 CSS 규칙도 함께 걷어냈다 (죽은 규칙 금지)', () => {
    const css = readFileSync(new URL('../styles/display.css', import.meta.url), 'utf8');
    for (const name of [
      '.scene--game-victory',
      '.game__card--victory',
      '.victory__eyebrow',
      '.victory__crest',
      '.victory__logo',
      '.victory__team',
      '.victory__label',
      '.victory__event',
    ]) {
      expect(css, `${name} 규칙이 남아 있다`).not.toContain(`${name} {`);
      expect(css, `${name} 규칙이 남아 있다`).not.toContain(`${name},`);
    }
    expect(css).not.toContain('@keyframes victory-crest-in');
    expect(css).not.toContain('@keyframes victory-label-in');
  });
});
