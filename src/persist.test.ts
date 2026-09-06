/**
 * P4 생존 — 경기 중 앱/브라우저가 죽어도 자료가 남아야 한다.
 *
 * 여기서 검증하는 것:
 *  1) 로고·영상까지 연결된 상태가 저장 → 새 컨텍스트 로드 라운드트립에서 그대로 살아난다
 *     (로고는 base64가 아니라 assetId로 들어가므로 상태 크기가 폭발하지 않는다)
 *  2) localStorage 용량이 초과되면 **조용히 실패하지 않고** 오류가 표면화된다
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./music', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./music')>();
  const fixture = await import('./test-music-fixture');
  return {
    ...actual,
    MUSIC_TRACKS: fixture.SYNTHETIC_MUSIC_TRACKS,
    musicTrack: fixture.syntheticMusicTrack,
  };
});
import {
  LS_KEY,
  activeTeams,
  createInitialState,
  getSaveError,
  loadLocal,
  reducer,
  saveLocal,
  serialize,
  type Action,
} from './state';
import type { AppState } from './types';

/** localStorage 흉내 — 용량 한도를 바이트로 지정할 수 있다 */
function installStorage(limitBytes = Infinity): Map<string, string> {
  const store = new Map<string, string>();
  const fake = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (v.length > limitBytes) {
        throw new DOMException('quota', 'QuotaExceededError');
      }
      store.set(k, v);
    },
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true });
  return store;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'localStorage');
});

function run(state: AppState, ...actions: Action[]): AppState {
  return actions.reduce(reducer, state);
}

/** 행사 도중 상태 — 팀 설정 + 로고 + 영상 에셋 + 확정된 점수 */
function liveState(): AppState {
  return run(
    createInitialState(),
    { type: 'teams/count', count: 5 },
    { type: 'team/patch', teamId: 't1', patch: { name: '불꽃', color: '#b0463c', logoAssetId: 'logo_t1_abc' } },
    { type: 'team/patch', teamId: 't2', patch: { name: '파도', color: '#3a6ea5' } },
    {
      type: 'assets/set',
      assets: [
        {
          id: 'a1',
          name: 'test_01.mov',
          type: 'video',
          size: 27_800_000,
          mime: 'video/quicktime',
          durationSec: 14.2,
          nextScene: 'standby',
          cueAfter: 'open',
          order: 0,
        },
      ],
    },
    { type: 'p1/rank', eventId: 'curling', teamId: 't1', rank: 1 },
    { type: 'p1/rank', eventId: 'curling', teamId: 't2', rank: 2 },
    { type: 'p1/confirm', eventId: 'curling', now: 1_700_000_000_000 },
  );
}

describe('저장 → 새 컨텍스트 로드 라운드트립', () => {
  it('팀 이름·컬러·로고 id·확정 4팀·영상 에셋 연결·원장이 모두 복구된다', () => {
    installStorage();
    const before = liveState();
    expect(saveLocal(before)).toBe(true);

    // "새 컨텍스트" — 메모리의 state를 버리고 저장소에서만 읽는다
    const after = loadLocal()!;
    expect(after).not.toBeNull();

    expect(after.teamCount).toBe(4);
    expect(activeTeams(after)).toHaveLength(4);
    expect(after.teams[0].name).toBe('불꽃');
    expect(after.teams[0].color).toBe('#b0463c');
    expect(after.teams[0].logoAssetId).toBe('logo_t1_abc');

    expect(after.assets).toHaveLength(1);
    expect(after.assets[0].name).toBe('test_01.mov');
    expect(after.assets[0].cueAfter).toBe('open');
    expect(after.assets[0].nextScene).toBe('standby');

    expect(after.ledger).toHaveLength(2);
    expect(after.p1.events[0].confirmedAt).not.toBeNull();
  });

  it('로고를 assetId로 두면 상태 크기가 작게 유지된다 (base64였다면 수백 KB)', () => {
    installStorage();
    const json = serialize(liveState());
    // 로고 6개가 base64였다면 손쉽게 수백 KB가 된다. id만 넣으면 수 KB 수준이어야 한다.
    expect(json.length).toBeLessThan(20_000);
    expect(json).not.toMatch(/data:image/);
  });

  it('저장 키는 하나뿐이라 다른 창이 그대로 받아 읽는다', () => {
    const store = installStorage();
    saveLocal(liveState());
    expect([...store.keys()]).toEqual([LS_KEY]);
  });

  it('저장 당시 음악이 재생 중이어도 새 브라우저에서는 선택만 복구하고 자동 재생하지 않는다', () => {
    installStorage();
    const playing = reducer(createInitialState(), {
      type: 'music/play',
      trackId: '20',
      now: 123,
    });
    expect(saveLocal(playing)).toBe(true);

    const restored = loadLocal()!;
    expect(restored.music.trackId).toBe('20');
    expect(restored.music.playing).toBe(false);
    expect(restored.music.positionSec).toBe(0);
  });
});

describe('용량 초과는 조용히 실패하지 않는다', () => {
  it('QuotaExceededError면 saveLocal이 false를 돌려주고 사유가 남는다', () => {
    installStorage(10); // 10바이트 — 무조건 초과
    const ok = saveLocal(liveState());
    expect(ok).toBe(false);
    const err = getSaveError();
    expect(err).toBeTruthy();
    expect(err).toContain('용량');
  });

  it('용량이 회복되면 오류 표시도 해제된다', () => {
    installStorage(10);
    expect(saveLocal(liveState())).toBe(false);
    expect(getSaveError()).toBeTruthy();

    installStorage(); // 한도 없음
    expect(saveLocal(liveState())).toBe(true);
    expect(getSaveError()).toBeNull();
  });

  it('저장소 자체가 없어도 앱은 죽지 않는다 (사파리 프라이빗 등)', () => {
    Reflect.deleteProperty(globalThis, 'localStorage');
    expect(() => saveLocal(liveState())).not.toThrow();
    expect(saveLocal(liveState())).toBe(false);
    expect(getSaveError()).toBeTruthy();
    expect(loadLocal()).toBeNull();
  });
});
