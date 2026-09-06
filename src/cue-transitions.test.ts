import { describe, expect, it } from 'vitest';

import {
  cueTransitionChoices,
  cueTransitionOf,
  hasCueTransitions,
  normalizeCueTransitions,
  setCueTransition,
} from './cue-transitions';
import { cueActions } from './cue';
import { createInitialState, deserialize, reducer, serialize } from './state';
import { routeSceneActionsThroughDefaultTransition } from './scene-routing';

describe('큐 경계 전환 선택 (U42)', () => {
  it('아이콘은 전역 따르기 + 세 방식, 고정 순서 넷이다', () => {
    const choices = cueTransitionChoices('stinger');
    expect(choices.map((c) => c.mode)).toEqual([null, 'white', 'black', 'stinger']);
    // 전역 따르기 설명은 지금 전역이 무엇인지를 그 자리에서 알려 준다
    expect(choices[0].tip).toContain('스팅어');
    for (const c of choices) {
      expect(c.mark).toBeTruthy();
      expect(c.label).toBeTruthy();
      expect(c.tip).toBeTruthy();
    }
  });

  it('지정하지 않은 경계는 전역을 따른다', () => {
    expect(cueTransitionOf({}, 'pre-mission')).toBeNull();
    expect(cueTransitionOf({ a: 'black' }, 'b')).toBeNull();
    expect(cueTransitionOf({ a: 'black' }, null)).toBeNull();
  });

  it('해제는 키 자체를 지운다 — 센티널을 남기면 [전부 전역으로]가 무의미해진다', () => {
    const set = setCueTransition({}, 'a', 'black');
    expect(set).toEqual({ a: 'black' });
    expect(setCueTransition(set, 'a', null)).toEqual({});
    expect(hasCueTransitions(set)).toBe(true);
    expect(hasCueTransitions({})).toBe(false);
    // 바뀌는 것이 없으면 같은 참조 (헛 재렌더·방송 금지)
    expect(setCueTransition(set, 'a', 'black')).toBe(set);
    expect(setCueTransition({}, 'a', null)).toEqual({});
  });

  it('저장본의 알 수 없는 방식은 버린다 — 그 자리가 조용히 하드컷이 되면 안 된다', () => {
    expect(normalizeCueTransitions(null)).toEqual({});
    expect(normalizeCueTransitions({ a: 'black', b: 'rainbow', c: 7 })).toEqual({ a: 'black' });
  });
});

describe('큐 경계 전환 액션 (U42)', () => {
  it('지정·해제·전부 전역으로가 상태에 반영된다', () => {
    let s = createInitialState();
    s = reducer(s, { type: 'cueTransitions/set', cueId: 'c1', mode: 'black' });
    s = reducer(s, { type: 'cueTransitions/set', cueId: 'c2', mode: 'white' });
    expect(s.cueTransitions).toEqual({ c1: 'black', c2: 'white' });

    const cleared = reducer(s, { type: 'cueTransitions/set', cueId: 'c1', mode: null });
    expect(cleared.cueTransitions).toEqual({ c2: 'white' });

    const all = reducer(s, { type: 'cueTransitions/clear' });
    expect(all.cueTransitions).toEqual({});
    // 이미 비어 있으면 상태를 갈지 않는다
    expect(reducer(all, { type: 'cueTransitions/clear' })).toBe(all);
  });

  it('저장·방송 왕복에서 살아남고, 옛 저장본은 빈 맵으로 인수된다', () => {
    const s = reducer(createInitialState(), { type: 'cueTransitions/set', cueId: 'c1', mode: 'black' });
    expect(deserialize(serialize(s)).cueTransitions).toEqual({ c1: 'black' });
    const legacy = JSON.parse(serialize(createInitialState()));
    delete legacy.cueTransitions;
    expect(deserialize(JSON.stringify(legacy)).cueTransitions).toEqual({});
  });
});

/**
 * 적용은 **중앙 경계 하나**에서만 일어난다 (`scene-routing.ts`).
 * 큐가 별도 경로로 전환을 내면 씬 소유자가 둘이 되어 늦게 도착한 쪽이 화면을 덮는다.
 */
describe('경계 선택이 중앙 경계를 통해 적용된다 (U42)', () => {
  const run = (state: ReturnType<typeof createInitialState>, mode?: 'white' | 'black' | 'stinger') =>
    routeSceneActionsThroughDefaultTransition(
      state,
      cueActions(
        { id: 'c1', label: 'x', hint: '', scene: 'score' },
        3,
        1000,
        undefined,
        mode ?? null,
      ),
      1000,
    );

  it('지정이 없으면 전역 방식이 그대로 쓰인다', () => {
    const s = createInitialState();
    s.settings.sceneTransitionMode = 'black';
    const out = run(s);
    expect(out.some((a) => a.type === 'sceneFade/play' && a.color === '#000000')).toBe(true);
  });

  it('경계 지정이 전역을 이긴다', () => {
    const s = createInitialState();
    s.settings.sceneTransitionMode = 'black';
    const out = run(s, 'white');
    expect(out.some((a) => a.type === 'sceneFade/play' && a.color === '#ffffff')).toBe(true);
    expect(out.some((a) => a.type === 'sceneFade/play' && a.color === '#000000')).toBe(false);
  });

  it('스팅어 지정은 전환 영상이 없으면 예전처럼 하드컷으로 수렴한다', () => {
    const s = createInitialState();
    s.settings.sceneTransitionMode = 'black';
    const out = run(s, 'stinger');
    expect(out.some((a) => a.type === 'sceneFade/play')).toBe(false);
    expect(out.some((a) => a.type === 'scene/set')).toBe(true);
  });

  it('영상 큐는 scene/set을 내지 않으므로 지정이 걸릴 자리가 없다 (시작 전 전환만)', () => {
    const s = createInitialState();
    const out = routeSceneActionsThroughDefaultTransition(
      s,
      cueActions(
        { id: 'v1', label: 'v', hint: '', scene: 'video', assetId: 'a1', assetPlayMode: 'full' },
        1,
        1000,
        undefined,
        'white',
      ),
      1000,
    );
    expect(out.some((a) => a.type === 'sceneFade/play')).toBe(false);
    expect(out.some((a) => a.type === 'video/playFull')).toBe(true);
  });
});
