/**
 * 매치 영상 (U36) — 출전 명단 앞 대결 소개 영상 6개.
 *
 * 여기서 지키는 계약:
 *  1) 좌·우 순서는 **파일이 정한다** (앱에 조합표를 두지 않는다)
 *  2) 색 이름은 `DEFAULT_TEAM_NAMES`에서 파생한다 (하드코딩 금지 — U30 실패 모드)
 *  3) 4팀 6조합에 모두 영상이 있고, 그 파일이 manifest와 실제 디스크에 있다
 */

import { describe, expect, it } from 'vitest';
// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { existsSync, readFileSync } from 'node:fs';

import {
  MATCH_FILE_ORDER,
  findMatchVideo,
  isMatchVideoAsset,
  matchAssetId,
  matchPairOrderIndex,
  matchVideoFile,
} from './match-video';
import { teamPairChoices, versusPairOptions, versusTileActions } from './versus-pairs';
import { CUE } from './cue';
import { DEFAULT_TEAM_NAMES, createInitialState, activeTeamIds, getTeam } from './state';
import type { AssetMeta, TeamId } from './types';

const manifestFiles = JSON.parse(
  readFileSync(new URL('../public/media/manifest.json', import.meta.url), 'utf8'),
) as { file: string; mode?: string; holdEndFrame?: boolean }[];
// 공개본에는 미디어가 없으므로 순수 매핑 테스트는 격리된 synthetic fixture를 사용한다.
const matchEntries = manifestFiles.filter((item) => item.file.startsWith('match_')).length
  ? manifestFiles.filter((item) => item.file.startsWith('match_'))
  : MATCH_FILE_ORDER.map((file) => ({ file, mode: 'overlay', holdEndFrame: true }));

function assetsFrom(files: string[]): AssetMeta[] {
  return files.map((file) => ({
    id: matchAssetId(file),
    name: file,
    type: 'video',
    size: 1,
    mime: 'video/webm',
    playMode: 'overlay',
  })) as AssetMeta[];
}

const ALL_MATCH_ASSETS = assetsFrom(matchEntries.map((item) => item.file));

describe('매치 영상 파일 해석', () => {
  it('슬롯 색 이름에서 파일 이름을 만든다', () => {
    const [yellow, blue] = DEFAULT_TEAM_NAMES.map((name) => name.toLowerCase());
    expect(matchVideoFile('t1', 't2')).toBe(`match_${yellow}_${blue}.webm`);
    expect(matchVideoFile('t2', 't1')).toBe(`match_${blue}_${yellow}.webm`);
  });

  it('같은 팀끼리·오피셜 밖 슬롯은 파일이 없다', () => {
    expect(matchVideoFile('t1', 't1')).toBeNull();
    expect(findMatchVideo(ALL_MATCH_ASSETS, 't1', 't1')).toBeNull();
  });

  it('존재하는 방향의 파일을 고르고 그 방향이 좌·우가 된다', () => {
    const forward = findMatchVideo(ALL_MATCH_ASSETS, 't2', 't3');
    const reversed = findMatchVideo(ALL_MATCH_ASSETS, 't3', 't2');
    expect(forward).not.toBeNull();
    // 어느 쪽에서 물어도 같은 파일·같은 좌·우가 나와야 보더가 영상과 어긋나지 않는다
    expect(reversed).toEqual(forward);
  });

  it('등록되지 않은 조합은 null이다 (보더만 설정)', () => {
    expect(findMatchVideo([], 't1', 't2')).toBeNull();
  });

  it('매치 영상 에셋만 큐 자동 편입 제외 대상으로 판정한다', () => {
    expect(isMatchVideoAsset(matchAssetId('match_blue_red.webm'))).toBe(true);
    expect(isMatchVideoAsset('media:olympic_intro_v001.mp4')).toBe(false);
    expect(isMatchVideoAsset('upload-1')).toBe(false);
  });
});

describe('4팀 6조합이 모두 실제 파일과 짝이 맞는다', () => {
  const state = createInitialState();
  const pairs = teamPairChoices(activeTeamIds(state));

  it('조합 수와 등록된 매치 영상 수가 같다', () => {
    expect(pairs).toHaveLength(6);
    expect(matchEntries).toHaveLength(6);
  });

  it.each(pairs)('%s vs %s 조합에 매치 영상이 있다', (a: TeamId, b: TeamId) => {
    const found = findMatchVideo(ALL_MATCH_ASSETS, a, b);
    expect(found).not.toBeNull();
    if (manifestFiles.length) expect(existsSync(new URL(`../public/media/${found!.file}`, import.meta.url))).toBe(true);
  });

  it('매치 영상은 알파 오버레이로 등록되고 마지막 프레임을 유지한다', () => {
    for (const entry of matchEntries) {
      expect(entry.mode).toBe('overlay');
      expect(entry.holdEndFrame).toBe(true);
    }
  });
});

describe('대결 타일 (U36)', () => {
  const state = createInitialState();
  const ids = activeTeamIds(state);
  const teamOf = (id: TeamId) => getTeam(state, id);

  it('영상이 있는 조합은 파일 순서를 적용 순서로 쓴다', () => {
    const options = versusPairOptions(ids, null, teamOf, ALL_MATCH_ASSETS);
    expect(options).toHaveLength(6);
    for (const option of options) {
      const found = findMatchVideo(ALL_MATCH_ASSETS, option.pair[0], option.pair[1])!;
      expect(option.matchAssetId).toBe(found.assetId);
      expect(option.apply).toEqual(found.order);
    }
  });

  it('영상이 없으면 예전 규칙대로 보더만 설정한다', () => {
    const options = versusPairOptions(ids, null, teamOf, []);
    for (const option of options) {
      expect(option.matchAssetId).toBeNull();
      expect(option.apply).toEqual(option.pair);
    }
    const [first] = options;
    expect(versusTileActions(first, 42)).toEqual([
      { type: 'sceneOpts/patch', patch: { liveOverlay: { versus: first.apply } } },
    ]);
  });

  it('클릭 한 번이 보더 설정과 매치 영상 재생을 함께 낸다', () => {
    const [option] = versusPairOptions(ids, null, teamOf, ALL_MATCH_ASSETS);
    expect(versusTileActions(option, 42)).toEqual([
      { type: 'sceneOpts/patch', patch: { liveOverlay: { versus: option.apply } } },
      { type: 'overlay/play', assetId: option.matchAssetId, holdEndFrame: true, now: 42 },
    ]);
  });

  /**
   * U57 — 좌우 바꾸기는 **출력만** 뒤집는다. 예전에는 타일도 같이 뒤집혀 운영자 눈에는
   * 카드가 자리를 옮긴 것처럼 보였다. 지금은 좌·우 표시가 영상 파일 배치에 못 박혀 있다.
   */
  it('좌우를 바꿔도 타일은 영상 파일 배치 그대로 그린다 (출력만 뒤집힌다)', () => {
    const [option] = versusPairOptions(ids, null, teamOf, ALL_MATCH_ASSETS);
    const swapped: [TeamId, TeamId] = [option.apply[1], option.apply[0]];
    const after = versusPairOptions(ids, swapped, teamOf, ALL_MATCH_ASSETS).find(
      (candidate) => candidate.fid === option.fid,
    )!;
    expect(after.selected).toBe(true);
    expect(after.left.id).toBe(option.left.id);
    expect(after.right.id).toBe(option.right.id);
    // 다시 누르면 영상 배치로 되돌아온다 — 영상과 보더가 어긋난 채 재생되지 않게
    expect(after.apply).toEqual(option.apply);
  });

  it('타일에 그리는 좌·우가 곧 매치 파일이 정한 배치다', () => {
    for (const option of versusPairOptions(ids, null, teamOf, ALL_MATCH_ASSETS)) {
      const found = findMatchVideo(ALL_MATCH_ASSETS, option.pair[0], option.pair[1])!;
      expect([option.left.id, option.right.id]).toEqual(found.order);
    }
  });
});

/**
 * U57 — 타일 순서 정본. `MATCH_FILE_ORDER`는 디스크 목록의 거울이라, manifest가 바뀌면
 * 여기서 먼저 어긋남이 드러나야 한다(런처에서 조용히 뒤로 밀린 타일로 알게 되면 늦다).
 */
describe('매치 파일 순서 (U57)', () => {
  const state = createInitialState();

  it('파일 이름 알파벳순 그대로이고 manifest의 매치 영상과 정확히 같은 집합이다', () => {
    expect([...MATCH_FILE_ORDER]).toEqual([...MATCH_FILE_ORDER].sort());
    expect([...MATCH_FILE_ORDER].sort()).toEqual(matchEntries.map((item) => item.file).sort());
  });

  it('조합의 자리는 두 방향 파일 이름 중 실제로 있는 쪽에서 나온다', () => {
    const pairs = teamPairChoices(activeTeamIds(state));
    const seats = pairs.map(([a, b]) => matchPairOrderIndex(a, b)).sort((x, y) => x - y);

    expect(seats).toEqual([0, 1, 2, 3, 4, 5]);
    // 어느 방향에서 물어도 같은 자리다
    expect(matchPairOrderIndex('t2', 't3')).toBe(matchPairOrderIndex('t3', 't2'));
  });

  it('파일이 없는 조합은 Infinity라 목록 뒤로 밀린다', () => {
    expect(matchPairOrderIndex('t1', 't1')).toBe(Number.POSITIVE_INFINITY);
    expect(matchPairOrderIndex('t5', 't6')).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('2부 잠금 계약', () => {
  it('매치 영상은 1부 기능이라 잠금 대상도 후반 문자열도 아니다', () => {
    const source = readFileSync(new URL('./match-video.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/후반|용의자|범인|2부|p2/);
    for (const item of CUE.filter((cue) => cue.matchEventId)) {
      expect(item.locked).toBeUndefined();
      expect(item.phase).toBe('p1');
      expect(`${item.label} ${item.hint}`).not.toMatch(/후반|용의자|범인|2부/);
    }
  });
});

/**
 * 타일 클릭이 항상 영상을 재생해 리허설에서 쓸 수 없던 문제. 보더만 고칠 경로를 연다.
 *
 * 처음에는 카드 안 [클릭 시 영상 재생] 토글이 그 경로였다. U63에서 **좌/우 절반 클릭**이
 * 토글을 대체했다 — 토글은 "지금 켜져 있나"를 매번 다시 읽어야 하는 숨은 상태라, 절반을
 * 눌렀는데 아무 영상도 안 나오는(또는 그 반대의) 두 번째 실패 모드를 만들었다.
 * `versusTileActions`의 계약(인자 하나로 갈린다)은 그대로다.
 */
describe('대결 타일 영상 재생 경로 (U63)', () => {
  const state = createInitialState();
  const ids = activeTeamIds(state);
  const teamOf = (id: TeamId) => getTeam(state, id);

  it('기본은 보더 + 영상 (사용자 지시 유지)', () => {
    const [option] = versusPairOptions(ids, null, teamOf, ALL_MATCH_ASSETS);
    expect(versusTileActions(option, 7)).toHaveLength(2);
  });

  it('영상 끄면 보더만 바꾼다 — 조합 값은 똑같다', () => {
    const [option] = versusPairOptions(ids, null, teamOf, ALL_MATCH_ASSETS);
    const borderOnly = versusTileActions(option, 7, false);
    expect(borderOnly).toEqual([
      { type: 'sceneOpts/patch', patch: { liveOverlay: { versus: option.apply } } },
    ]);
    expect(borderOnly.some((a) => a.type === 'overlay/play')).toBe(false);
  });

  it('런처는 좌표·Shift·키보드를 한 순수 함수에 넘겨 갈린다', () => {
    const launcher = readFileSync(new URL('./control/launcher.ts', import.meta.url), 'utf8');
    expect(launcher).toContain('versusTileHalf(me.clientX, rect, me.shiftKey, me.detail)');
    expect(launcher).toContain('getBoundingClientRect()');
    expect(launcher).toContain("toast('매치 영상을 재생합니다')");
  });

  it('예전 [클릭 시 영상 재생] 토글은 런처에 남아 있지 않다', () => {
    const launcher = readFileSync(new URL('./control/launcher.ts', import.meta.url), 'utf8');
    expect(launcher).not.toContain('versusPlaysVideo');
    expect(launcher).not.toContain("fid: 'versus-play-video'");
    expect(launcher).not.toContain('클릭 시 영상 재생');
  });
});
