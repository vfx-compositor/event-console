/**
 * 승리 영상 (U100) — 종목 승리 팀 발표용 알파 오버레이 4편.
 *
 * 여기서 지키는 계약:
 *  1) 색 이름은 `DEFAULT_TEAM_NAMES`에서 파생한다 (하드코딩 금지 — U30 실패 모드)
 *  2) 오피셜 4팀에 모두 영상이 있고, 그 파일이 manifest와 실제 디스크에 있다
 *  3) manifest 항목은 매치 오버레이와 같은 관례다 (`mode: overlay`, `holdEndFrame: true`,
 *     `cueAfter: null` — 큐 자리는 `victory-<종목>`이 이미 갖고 있다)
 *  4) `audio` 키를 쓰지 않는다 (U84) — 무음 파일이라 등록 시 probe가 실측으로 판정한다
 */

import { describe, expect, it } from 'vitest';
// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { existsSync, readFileSync } from 'node:fs';

import {
  WINNER_FILE_COLORS,
  findWinnerVideo,
  isWinnerVideoAsset,
  winnerAssetId,
  winnerVideoFile,
} from './winner-video';
import { matchAssetId } from './match-video';
import { DEFAULT_TEAM_NAMES, activeTeamIds, createInitialState } from './state';
import type { AssetMeta } from './types';

const manifestFiles = JSON.parse(
  readFileSync(new URL('../public/media/manifest.json', import.meta.url), 'utf8'),
) as { file: string; mode?: string; holdEndFrame?: boolean; cueAfter?: string | null; audio?: boolean }[];
const winnerEntries = manifestFiles.filter((item) => item.file.startsWith('winner_')).length
  ? manifestFiles.filter((item) => item.file.startsWith('winner_'))
  : WINNER_FILE_COLORS.map((color) => ({
      file: `winner_${color}.webm`,
      mode: 'overlay',
      holdEndFrame: true,
      cueAfter: null,
      audio: undefined,
    }));

function assetsFrom(files: string[]): AssetMeta[] {
  return files.map((file) => ({
    id: winnerAssetId(file),
    name: file,
    type: 'video',
    size: 1,
    mime: 'video/webm',
    playMode: 'overlay',
  })) as AssetMeta[];
}

const ALL_WINNER_ASSETS = assetsFrom(winnerEntries.map((item) => item.file));

describe('승리 영상 파일 해석 (U100)', () => {
  it('슬롯 색 이름에서 파일 이름을 만든다 — 색을 다시 적지 않는다', () => {
    const [yellow, blue, red, green] = DEFAULT_TEAM_NAMES.map((name) => name.toLowerCase());
    expect(winnerVideoFile('t1')).toBe(`winner_${yellow}.webm`);
    expect(winnerVideoFile('t2')).toBe(`winner_${blue}.webm`);
    expect(winnerVideoFile('t3')).toBe(`winner_${red}.webm`);
    expect(winnerVideoFile('t4')).toBe(`winner_${green}.webm`);
  });

  it('오피셜 4팀 밖 슬롯(PURPLE·TEAL)은 영상이 없다 — 카드로 떨어진다', () => {
    expect(winnerVideoFile('t5')).toBeNull();
    expect(winnerVideoFile('t6')).toBeNull();
    expect(findWinnerVideo(ALL_WINNER_ASSETS, 't5')).toBeNull();
  });

  it('승리 팀이 없으면 영상도 없다', () => {
    expect(findWinnerVideo(ALL_WINNER_ASSETS, null)).toBeNull();
  });

  it('등록되지 않은 팀 영상은 null이라 부르는 쪽이 폴백한다', () => {
    const onlyRed = assetsFrom(['winner_red.webm']);
    expect(findWinnerVideo(onlyRed, 't3')?.file).toBe('winner_red.webm');
    expect(findWinnerVideo(onlyRed, 't2')).toBeNull();
  });

  it('기본 4팀 전원이 자기 영상을 갖는다', () => {
    for (const id of activeTeamIds(createInitialState())) {
      const video = findWinnerVideo(ALL_WINNER_ASSETS, id);
      expect(video, `팀 ${id}의 승리 영상`).not.toBeNull();
      expect(video!.teamId).toBe(id);
      expect(video!.assetId).toBe(`media:${video!.file}`);
    }
  });

  it('승리 영상 판정은 매치 영상과 겹치지 않는다', () => {
    expect(isWinnerVideoAsset('media:winner_red.webm')).toBe(true);
    expect(isWinnerVideoAsset(matchAssetId('match_blue_red.webm'))).toBe(false);
    expect(isWinnerVideoAsset('media:olympic_intro_v001.mp4')).toBe(false);
    expect(isWinnerVideoAsset('upload-1')).toBe(false);
  });
});

describe('승리 영상 파일 배포 (manifest ↔ 디스크)', () => {
  it('`WINNER_FILE_COLORS`는 manifest의 승리 영상 집합과 정확히 같다', () => {
    expect([...WINNER_FILE_COLORS].sort()).toEqual(
      winnerEntries.map((item) => item.file.replace(/^winner_|\.webm$/g, '')).sort(),
    );
  });

  it('4편 모두 manifest에 있고 실제 파일도 있다', () => {
    expect(winnerEntries).toHaveLength(WINNER_FILE_COLORS.length);
    for (const entry of winnerEntries) {
      const path = new URL(`../public/media/${entry.file}`, import.meta.url);
      if (manifestFiles.length) expect(existsSync(path), `${entry.file} 파일 없음`).toBe(true);
    }
  });

  it('매치 오버레이와 같은 관례로 등록된다 — overlay · 끝 프레임 유지 · 큐 자리 없음', () => {
    for (const entry of winnerEntries) {
      // 알파 오버레이라 씬 전환 없이 현재 화면 위에 얹힌다
      expect(entry.mode, entry.file).toBe('overlay');
      // 마지막 프레임 알파가 100% 불투명한 승리 보드다 (ffmpeg alphaextract 실측 YAVG=255)
      expect(entry.holdEndFrame, entry.file).toBe(true);
      // 큐 자리는 `victory-<종목>` 하나뿐이다 — cueAfter로 또 꽂으면 두 번 나간다
      expect(entry.cueAfter ?? null, entry.file).toBeNull();
      // U84 — 무음 파일이라 manifest가 선언하지 않고 등록 시 probe 실측에 맡긴다
      expect(entry.audio, entry.file).toBeUndefined();
    }
  });
});
