/**
 * U39 — 영상·에셋 탭을 콤팩트 행 목록에서 **카드 그리드**로 바꿨다.
 *
 * 여기서 지키는 계약:
 *  1) 분류는 순수 함수 하나가 정한다 (판정 순서가 계약 — 대본 고정·매치가 media보다 먼저다)
 *  2) 대본이 자리를 정해 둔 영상의 큐 셀렉트는 잠긴다
 *  3) 상태 계약(`assets/set`·`sceneOpts.video`·IndexedDB)은 뷰 교체로 바뀌지 않는다
 *  4) 1부 화면에 나가는 문자열에 2부 어휘가 없다
 */

import { describe, expect, it } from 'vitest';
// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { readFileSync } from 'node:fs';

import {
  ASSET_SECTION_ORDER,
  assetCardMeta,
  assetSectionOf,
  assetSections,
  assetThumbFallback,
  nextAssetCardFocus,
} from './asset-sections';
import { defaultHoldEndFrame, holdEndFrameUpgrades } from './tab-assets';
import { matchAssetId } from '../match-video';
import type { AssetMeta } from '../types';

const source = readFileSync(new URL('./tab-assets.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../styles/control.css', import.meta.url), 'utf8');

function asset(id: string, over: Partial<AssetMeta> = {}): AssetMeta {
  return {
    id,
    name: id,
    type: 'video',
    size: 2 * 1024 * 1024,
    mime: 'video/mp4',
    playMode: 'full',
    order: 0,
    ...over,
  } as AssetMeta;
}

describe('에셋 섹션 분류 (U39)', () => {
  it('대본 고정 · 매치 · 승리 · 대기/전환 · 운영자 등록 다섯 묶음으로 나눈다', () => {
    expect(ASSET_SECTION_ORDER).toEqual(['scripted', 'match', 'winner', 'ambient', 'user']);
    expect(assetSectionOf(asset('media:olympic_intro_v001.mp4'))).toBe('scripted');
    expect(assetSectionOf(asset('media:intro_curling.mp4'))).toBe('scripted');
    expect(assetSectionOf(asset(matchAssetId('match_blue_red.webm')))).toBe('match');
    // U100 — 승리 영상은 매치와 성격이 다르다(한 팀·배치 없음). 따로 접힌다.
    expect(assetSectionOf(asset('media:winner_red.webm', { playMode: 'overlay' }))).toBe('winner');
    expect(assetSectionOf(asset('media:main_standby.jpeg', { type: 'image' }))).toBe('ambient');
    expect(assetSectionOf(asset('media:bridge_stinger_short.webm', { playMode: 'transition' }))).toBe(
      'ambient',
    );
    expect(assetSectionOf(asset('upload-1'))).toBe('user');
  });

  it('대본 고정·매치·승리는 media 폴더 유래여도 대기·전환으로 새지 않는다', () => {
    // 판정 순서가 뒤집히면 세 묶음이 전부 `ambient`로 빨려 들어간다
    for (const id of [
      'media:olympic_intro_v001.mp4',
      matchAssetId('match_green_red.webm'),
      'media:winner_green.webm',
    ]) {
      expect(assetSectionOf(asset(id))).not.toBe('ambient');
    }
  });

  it('비어 있는 묶음은 그리지 않고 순서는 고정이다', () => {
    const sections = assetSections([asset('upload-1'), asset('media:intro_one_mind.mp4')]);
    expect(sections.map((s) => s.id)).toEqual(['scripted', 'user']);
    expect(sections.every((s) => s.assets.length > 0)).toBe(true);
    expect(assetSections([])).toEqual([]);
  });

  it('묶음 안 순서는 넘겨받은 순서를 그대로 둔다 (↑↓ 정렬이 살아 있어야 한다)', () => {
    const list = [asset('u-2', { order: 1 }), asset('u-1', { order: 0 })];
    expect(assetSections(list)[0].assets.map((a) => a.id)).toEqual(['u-2', 'u-1']);
  });

  it('모든 묶음이 hover 상세를 갖는다', () => {
    const sections = assetSections([
      asset('media:intro_curling.mp4'),
      asset(matchAssetId('match_blue_red.webm')),
      asset('media:winner_blue.webm', { playMode: 'overlay' }),
      asset('media:main_standby.jpeg', { type: 'image' }),
      asset('upload-1'),
    ]);
    expect(sections).toHaveLength(5);
    for (const section of sections) expect(section.hint.length).toBeGreaterThan(20);
  });
});

describe('카드 모델 (U39)', () => {
  it('모드·길이·용량·소리·파일·revision을 한 번에 준다', () => {
    const meta = assetCardMeta(
      asset('media:olympic_intro_v001.mp4', {
        durationSec: 95.4,
        size: 27 * 1024 * 1024,
        sourceRevision: 'ba769c9565d0',
      }),
    );
    expect(meta.mode).toBe('full');
    expect(meta.modeLabel).toBe('풀스크린');
    expect(meta.duration).toBe('01:35');
    expect(meta.size).toBe('27.0 MB');
    expect(meta.audio).toBe('소리 켬');
    expect(meta.file).toBe('olympic_intro_v001.mp4');
    expect(meta.revision).toBe('ba769c9');
  });

  it('무음 풀스크린과 오버레이·이미지를 구분한다', () => {
    expect(assetCardMeta(asset('u1', { audio: false })).audio).toBe('무음');
    // 영상은 모드와 무관하게 소리 배지를 갖는다 — 전환 스팅어는 U102, 매치 알파 오버레이는
    // U101 C1(소리 든 v003)이 각각 열었다. 이미지만 `null`이다.
    expect(assetCardMeta(asset('u2', { playMode: 'overlay' })).audio).toBe('소리 켬');
    expect(assetCardMeta(asset('u2b', { playMode: 'overlay', audio: false })).audio).toBe('무음');
    // 전환 스팅어는 효과음 레이어라 소리가 난다 (U102) — 칩과 토글이 함께 열려 있어야 한다.
    expect(assetCardMeta(asset('u3', { playMode: 'transition' })).audio).toBe('소리 켬');
    expect(assetCardMeta(asset('u3b', { playMode: 'transition', audio: false })).audio).toBe('무음');
    const image = assetCardMeta(asset('u4', { type: 'image', size: 400 * 1024 }));
    expect(image.mode).toBeNull();
    expect(image.modeLabel).toBe('IMAGE');
    expect(image.duration).toBe('--:--');
    expect(image.size).toBe('400 KB');
  });

  it('길이를 모르면 --:--이고 revision이 없으면 null이다', () => {
    const meta = assetCardMeta(asset('u5'));
    expect(meta.duration).toBe('--:--');
    expect(meta.revision).toBeNull();
    expect(meta.file).toBeNull();
  });

  it('썸네일이 없으면 모드 글자로 자리를 채운다', () => {
    expect(assetThumbFallback(asset('u1', { playMode: 'transition' }))).toBe('전환');
    expect(assetThumbFallback(asset('u2', { playMode: 'overlay' }))).toBe('오버레이');
    expect(assetThumbFallback(asset('u3'))).toBe('풀스크린');
    expect(assetThumbFallback(asset('u4', { type: 'image' }))).toBe('IMAGE');
  });
});

describe('카드 키보드 내비 (U39)', () => {
  it('좌우는 wrap, 상하는 열 수만큼 이동하고 끝에서 멈춘다', () => {
    expect(nextAssetCardFocus('ArrowRight', 5, 6, 3)).toBe(0);
    expect(nextAssetCardFocus('ArrowLeft', 0, 6, 3)).toBe(5);
    expect(nextAssetCardFocus('ArrowDown', 0, 6, 3)).toBe(3);
    expect(nextAssetCardFocus('ArrowDown', 4, 6, 3)).toBe(5);
    expect(nextAssetCardFocus('ArrowUp', 1, 6, 3)).toBe(0);
    expect(nextAssetCardFocus('Home', 4, 6, 3)).toBe(0);
    expect(nextAssetCardFocus('End', 0, 6, 3)).toBe(5);
  });

  it('처리하지 않는 키는 null이라 전역 단축키가 그대로 흐른다', () => {
    expect(nextAssetCardFocus('Enter', 0, 6, 3)).toBeNull();
    expect(nextAssetCardFocus(' ', 0, 6, 3)).toBeNull();
    expect(nextAssetCardFocus('ArrowRight', 0, 0, 3)).toBeNull();
  });

  it('열 수를 못 읽어도 최소 1로 동작한다', () => {
    expect(nextAssetCardFocus('ArrowDown', 0, 3, 0)).toBe(1);
  });

  it('카드 자신이 아닌 안쪽 컨트롤의 키 입력에는 끼어들지 않는다', () => {
    expect(source).toContain('if (target !== ev.currentTarget) return;');
    // roving tabindex — Tab 한 번에 묶음 안으로 들어온다
    expect(source).toContain('tabIndex: i === 0 ? 0 : -1');
    expect(source).toContain("if (ev.key === 'Enter')");
  });
});

describe('상태 계약과 잠금 (U39)', () => {
  it('대본 고정 영상의 큐 셀렉트는 비활성이다', () => {
    expect(source).toContain('scriptedCue ? { disabled');
    expect(source).toContain('진행 대본이 위치를 고정한 영상입니다');
  });

  it('상태 액션과 IndexedDB 배선은 그대로다 — 뷰만 바뀌었다', () => {
    for (const needle of [
      "type: 'assets/set'",
      "type: 'transition/play'",
      "type: 'overlay/play'",
      'ctx.playAsset(a.id, nextScene)',
      'void patchAsset(a.id, p)',
      'void deleteAsset(a.id)',
      "type: 'media/hide'",
      'ctx.reloadAssets()',
    ]) {
      expect(source).toContain(needle);
    }
  });

  it('썸네일은 등록 시 뽑아 둔 dataURL만 쓴다 — 카드에서 objectURL을 만들지 않는다', () => {
    // 카드마다 blob URL을 만들면 언마운트에서 revoke를 놓쳐 세션 내내 쌓인다.
    // 등록·manifest 동기화가 이미 `thumbDataUrl`을 넣어 두므로 카드는 그것만 읽는다.
    const cardBlock = source.slice(source.indexOf('function assetCard('), source.indexOf('function playerBar('));
    expect(cardBlock).toContain('a.thumbDataUrl');
    expect(cardBlock).not.toContain('createObjectURL');
  });

  it('섹션 접힘은 상태가 아니라 탭 로컬이다', () => {
    expect(source).toContain('const collapsedSections = new Set<AssetSectionId>()');
    expect(source).not.toContain("type: 'settings/patch', patch: { assetSections");
  });

  it('1부 화면에 나가는 문자열에 2부 어휘가 없다', () => {
    const sectionSource = readFileSync(new URL('./asset-sections.ts', import.meta.url), 'utf8');
    expect(sectionSource).not.toMatch(/용의자|범인|알리바이/);
  });

  it('카드 텍스트는 넘치면 잘린다 (양수 자간 없음)', () => {
    for (const sel of ['.assetgroup__label', '.assetcard__name-input']) {
      const block = css.match(new RegExp(`\\${sel}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
      expect(block).toMatch(/text-overflow:\s*ellipsis/);
      expect(block).toMatch(/letter-spacing:\s*-/);
    }
  });
});

/**
 * U50 — "모든 미디어 영상들은 끝나고 마지막 프레임 홀드. 스팅어는 당연히 제외."
 */
describe('끝 프레임 홀드 기본값 (U50)', () => {
  it('전환 오버레이만 예외다', () => {
    expect(defaultHoldEndFrame('full')).toBe(true);
    expect(defaultHoldEndFrame('overlay')).toBe(true);
    expect(defaultHoldEndFrame(undefined)).toBe(true);
    expect(defaultHoldEndFrame('transition')).toBe(false);
  });

  it('manifest의 full·overlay 항목이 전부 홀드로 명시돼 있다', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../public/media/manifest.json', import.meta.url), 'utf8'),
    ) as { file: string; mode?: string; holdEndFrame?: boolean }[];
    const videos = manifest.filter((item) => /\.(mp4|webm|mov)$/i.test(item.file));
    expect(videos).toEqual([]);
    for (const item of videos) {
      if ((item.mode ?? 'full') === 'transition') {
        expect(item.holdEndFrame).toBeUndefined();
      } else {
        expect(item.holdEndFrame).toBe(true);
      }
    }
  });

  it('media 폴더 유래와 값이 없는 업로드만 승격한다', () => {
    const rows = [
      { id: 'media:olympic_intro_v001.mp4', type: 'video', playMode: 'full' as const, holdEndFrame: false },
      { id: 'media:match_blue_red.webm', type: 'video', playMode: 'overlay' as const, holdEndFrame: false },
      { id: 'media:bridge_stinger_short.webm', type: 'video', playMode: 'transition' as const },
      { id: 'upload-old', type: 'video', playMode: 'full' as const },
      { id: 'upload-off', type: 'video', playMode: 'full' as const, holdEndFrame: false },
      { id: 'upload-on', type: 'video', playMode: 'full' as const, holdEndFrame: true },
      { id: 'upload-image', type: 'image' as const },
    ];
    expect(holdEndFrameUpgrades(rows)).toEqual([
      'media:olympic_intro_v001.mp4',
      'media:match_blue_red.webm',
      'upload-old',
    ]);
  });

  it('운영자가 직접 끈 업로드와 스팅어는 건드리지 않는다', () => {
    expect(holdEndFrameUpgrades([{ id: 'upload-off', type: 'video', holdEndFrame: false }])).toEqual([]);
    expect(
      holdEndFrameUpgrades([
        { id: 'media:bridge_stinger.webm', type: 'video', playMode: 'transition', holdEndFrame: false },
      ]),
    ).toEqual([]);
  });

  it('승격은 한 번만 필요하다 — 결과가 true라 다음 부팅에는 후보가 아니다', () => {
    const promoted = [{ id: 'media:intro_curling.mp4', type: 'video', playMode: 'full' as const, holdEndFrame: true }];
    expect(holdEndFrameUpgrades(promoted)).toEqual([]);
  });

  it('새 업로드와 방식 변경도 같은 기본값을 쓴다', () => {
    expect(source).toContain("holdEndFrame: isVideo ? defaultHoldEndFrame('full') : false");
    expect(source).toContain('patch({ playMode, holdEndFrame: defaultHoldEndFrame(playMode) })');
    expect(source).toContain('void patchAsset(id, { holdEndFrame: true })');
  });
});
