import { describe, expect, it } from 'vitest';
// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { readFileSync } from 'node:fs';

import {
  liveBadgeChoices,
  newspaperRunnerLabel,
  p1EventInputLabel,
  p1ValueInputSpec,
  victoryLeader,
} from './tab-p1';
import { CUE, cueActions, victoryOutputActions, victoryOutputBlock } from '../cue';
import { rosterParticipation } from './tab-roster';

const css = readFileSync(new URL('../styles/control.css', import.meta.url), 'utf8');
const source = readFileSync(new URL('./tab-p1.ts', import.meta.url), 'utf8');

it('중계 배지는 네 종목과 숨김을 모두 제공한다', () => {
  expect(liveBadgeChoices()).toEqual([
    { id: 'curling', label: '컬링' },
    { id: 'newspaper', label: '신문지 달리기' },
    { id: 'sticky', label: '끈끈이 낚시' },
    { id: 'sync', label: '몸으로 말해요' },
    { id: null, label: '배지 숨김' },
  ]);
});

it('끈끈이 낚시는 팀당 1~2명의 획득 점수 입력을 제공한다 (U64)', () => {
  expect(p1ValueInputSpec('sticky')).toEqual({
    participation: '팀당 1~2명 출전',
    label: '획득 점수',
    suffix: '점',
  });
  // 명단 탭과 같은 문구여야 두 화면이 서로 다른 인원 규칙을 말하지 않는다
  expect(p1ValueInputSpec('sticky')?.participation).toBe(rosterParticipation('sticky'));
});

it('몸으로 말해요는 팀 전체의 성공 라운드 수 입력을 제공한다', () => {
  expect(p1ValueInputSpec('sync')).toEqual({
    participation: '팀 전체 참여',
    label: '성공 라운드 수',
    suffix: '라운드',
  });
});

it('신문지 달리기는 팀당 2명의 초 기록 입력을 제공한다', () => {
  expect(p1ValueInputSpec('newspaper')).toEqual({
    participation: '팀당 2명 출전',
    label: '선수별 기록',
    suffix: '초',
  });
});

it('네 종목 카드가 필요한 결과 입력 방식을 정확히 지정한다', () => {
  expect(p1EventInputLabel('curling')).toBe('대진·승패 입력');
  expect(p1EventInputLabel('newspaper')).toBe('기록·순위 입력');
  expect(p1EventInputLabel('sticky')).toBe('획득 점수 입력');
  expect(p1EventInputLabel('sync')).toBe('성공 라운드 입력');
});

it('신문지 기록 입력은 2열로 내려 선수 라벨·입력·초 단위가 침범하지 않는다', () => {
  expect(css).toMatch(/\.p1-value-inputs\.is-newspaper\s*\{[^}]*grid-template-columns:\s*repeat\(2,/s);
  // 라벨 열은 U38에서 52 → 96px (명단 이름이 들어온다). 세 열 구조 자체는 그대로다.
  expect(css).toMatch(/\.p1-runner-time\s*\{[^}]*grid-template-columns:\s*96px\s+minmax\(0,\s*1fr\)\s+18px/s);
});

it('1부 탭은 공용 eventgrid를 2부와 구분하는 전용 scope를 가진다', () => {
  expect(source).toContain("{ class: 'tabpane tabpane--p1' }");
});

/**
 * U71 — 종목마다 승리 팀을 고르면 그 자리에서 승리 보드가 나간다.
 */
describe('승리 팀 선택 (U71)', () => {
  const ids = ['t1', 't2', 't3', 't4'] as const;

  it('점수가 가장 높은 한 팀만 추천한다', () => {
    expect(victoryLeader({ t1: 3, t2: 5, t3: 1, t4: 0 }, [...ids])).toBe('t2');
    expect(victoryLeader({ t1: 5, t2: 5 }, [...ids])).toBeNull();
    expect(victoryLeader({}, [...ids])).toBeNull();
    expect(victoryLeader({ t1: 0, t2: 0, t3: 0, t4: 0 }, [...ids])).toBeNull();
    // 활성 팀 밖의 점수는 보지 않는다
    expect(victoryLeader({ t1: 2, t5: 9 } as Record<string, number>, [...ids])).toBe('t1');
  });

  /**
   * U109 (04:55 사용자 지시) — 팀 버튼은 **선택만**, 송출은 행 끝 버튼 하나.
   * DOM 없이 확인할 수 있는 배선만 소스에서 잠근다(렌더 동작은 아래 `victoryOutputActions` 계약).
   */
  it('팀 버튼은 승리 팀만 기록한다 — 씬을 직접 세우지 않는다', () => {
    expect(source).toContain("patch: { game: { winner: next } }");
    // U109 이전에 여기 있던 직접 `scene/set`은 사라졌다 — 송출은 공유 빌더만 낸다
    expect(source).not.toContain("opts: { game: { eventId: event.id, mode: 'victory' } }");
    expect(source).not.toContain("scene: 'game'");
  });

  it('송출은 큐시트와 같은 빌더를 부른다 (중복 구현 금지)', () => {
    expect(source).toContain("import { victoryMusicOf, victoryOutputActions, victoryOutputBlock } from '../cue';");
    expect(source).toContain('ctx.dispatch(victoryOutputActions(winner, s.assets, Date.now(), victoryMusicOf(s)))');
  });

  it('탭 [송출]과 큐시트 `victory-<종목>`이 **같은 배열**을 낸다 (U109 · U110)', () => {
    const assets = [{ id: 'media:winner_red.webm' }];
    const music = { trackId: '03', startSec: 8 };
    const item = CUE.find((c) => c.id === 'victory-curling')!;
    const index = CUE.findIndex((c) => c.id === 'victory-curling');
    // 큐가 내는 것에서 커서·진행단계를 뺀 나머지가 곧 송출 액션이다
    const fromCue = (a: { id: string }[]) =>
      cueActions(item, index, 42, {
        versus: null,
        assets: a,
        scene: 'live',
        gameEventId: 'curling',
        winner: 't3',
        victoryMusic: music,
      }).filter((x) => x.type !== 'cue/index' && x.type !== 'phase/set');

    // 영상 + 음악
    expect(victoryOutputActions('t3', assets, 42, music)).toEqual(fromCue(assets));
    // 영상이 없는 경우도 같은 자리로 수렴한다 — 양쪽 다 빈 배열이다 (U110, 카드 폐기)
    expect(victoryOutputActions('t3', [], 42, music)).toEqual(fromCue([]));
    expect(fromCue([])).toEqual([]);
  });

  it('승리 팀이 없거나 영상이 없으면 [송출]이 비활성이고 이유를 말한다 (U110)', () => {
    expect(source).toContain('const blocked = victoryOutputBlock(g.winner, s.assets);');
    expect(source).toContain('disabled: blocked !== null,');
    const assets = [{ id: 'media:winner_red.webm' }];
    expect(victoryOutputBlock(null, assets)).toMatch(/승리 팀/);
    expect(victoryOutputBlock('t3', assets)).toBeNull();
    // U110 — 카드 폴백이 없으니 영상 부재도 "나갈 것이 없다"다
    expect(victoryOutputBlock('t2', assets)).toBe('승리 영상 없음: winner_blue.webm');
  });

  it('송출 중 표시는 오버레이에 실린 파일로 판정한다 — 카드 씬이 사라졌다 (U110)', () => {
    expect(source).toContain('s.sceneOpts.overlayVideo.active ? s.sceneOpts.overlayVideo.assetId : null');
    expect(source).toContain('const onAir = winnerFile !== null && onAirAssetId === `media:${winnerFile}`');
    // 폐기된 카드 씬 판정이 남아 있으면 안 된다
    expect(source).not.toContain("g.mode === 'victory'");
  });

  it('이미 고른 팀을 다시 누르면 해제되고, Shift+클릭은 선택 + 즉시 송출이다', () => {
    expect(source).toContain('const next = picked && !ev.shiftKey ? null : id;');
    expect(source).toContain('if (ev.shiftKey) send(id);');
  });

  it('승리 팀 줄은 기존 control.css 클래스만 쓴다 (규칙 없는 클래스 금지)', () => {
    for (const name of ['overlaybar', 'seg', 'seg__btn', 'field__label', 'btn--tiny']) {
      expect(css).toContain(`.${name}`);
    }
    expect(source).toContain("class: 'overlaybar', attrs: { role: 'group'");
  });
});

/**
 * U38 — 신문지 달리기 주자 칸이 `선수 1`/`선수 2`라 현장에서 누구 기록인지 안 보인다.
 * 출전 명단에 이름이 들어오면 즉시 그 이름으로 바꾸되 순번은 남긴다.
 */
describe('신문지 달리기 주자 라벨 (U38)', () => {
  it('명단이 비어 있으면 기본 라벨을 유지한다', () => {
    for (const raw of [undefined, '', '   ', '\n,\n']) {
      const label = newspaperRunnerLabel(raw, 0, 'BLUE');
      expect(label.text).toBe('선수 1');
      expect(label.named).toBe(false);
      expect(label.tip).toContain('출전 명단');
    }
    expect(newspaperRunnerLabel('', 1, 'BLUE').text).toBe('선수 2');
  });

  it('이름이 있으면 순번을 남긴 채 즉시 대체한다', () => {
    const first = newspaperRunnerLabel('참가자 A, 참가자 B', 0, 'BLUE');
    const second = newspaperRunnerLabel('참가자 A, 참가자 B', 1, 'BLUE');
    expect(first.text).toBe('1 · 참가자 A');
    expect(second.text).toBe('2 · 참가자 B');
    expect(first.named).toBe(true);
    expect(first.aria).toContain('참가자 A');
    // 전체 이름은 툴팁에 남는다 (칸이 좁으면 라벨은 ellipsis로 잘린다)
    expect(first.tip).toContain('참가자 A');
  });

  it('n번째 선수가 없으면 그 칸만 기본 라벨로 남는다', () => {
    expect(newspaperRunnerLabel('참가자 A', 0, 'RED').text).toBe('1 · 참가자 A');
    expect(newspaperRunnerLabel('참가자 A', 1, 'RED').text).toBe('선수 2');
    expect(newspaperRunnerLabel('참가자 A', 1, 'RED').named).toBe(false);
  });

  it('줄바꿈 명단도 같은 순서로 읽고 동명이인을 합치지 않는다', () => {
    // 출력 화면(`parseRoster`)과 같은 해석이라야 화면 명단과 라벨이 같은 사람을 가리킨다
    expect(newspaperRunnerLabel('참가자 A\n참가자 A', 1, 'GREEN').text).toBe('2 · 참가자 A');
    expect(newspaperRunnerLabel(' 참가자 A \n 참가자 B ', 1, 'GREEN').text).toBe('2 · 참가자 B');
  });

  it('라벨 칸은 넘치면 잘리고 툴팁으로 전체를 보여 준다', () => {
    expect(source).toContain('p1-runner-time__who');
    expect(source).toContain('data: { tip: runnerLabel.tip }');
    const who = css.match(/\.p1-runner-time__who\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(who).toMatch(/text-overflow:\s*ellipsis/);
    expect(who).toMatch(/white-space:\s*nowrap/);
    // 이름이 들어갈 자리 — 기본 52px로는 두 글자도 안 들어간다
    const row = css.match(/\.p1-runner-time\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(Number.parseInt(row.match(/grid-template-columns:\s*(\d+)px/)?.[1] ?? '0', 10)).toBeGreaterThanOrEqual(96);
  });

  it('기록 값·원장 액션은 그대로다 — 라벨만 바뀐다', () => {
    expect(source).toContain("type: 'p1/newspaperTime'");
    expect(source).toContain("step: '0.01'");
  });
});
