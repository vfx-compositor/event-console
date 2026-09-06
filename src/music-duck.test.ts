import { describe, expect, it, vi } from 'vitest';

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
  DEFAULT_MUSIC_DUCK_SEC,
  MUSIC_DUCK_SEC_RANGE,
  assetOwnsScreen,
  assetPlaysAudio,
  cueOwnsScreen,
  duckedCueDue,
  duckedCueRemainingSec,
  fullVideoOwnsOutput,
  needsMusicDuck,
  overlayPlaysAudio,
  scheduleDuckedCue,
  videoAudioOwnsOutput,
} from './music-duck';
import { createInitialState, deserialize, reducer, resetRuntimeVideoPhase, serialize } from './state';
import type { AssetMeta } from './types';

const asset = (over: Partial<AssetMeta> = {}): AssetMeta => ({
  id: 'a1',
  name: '설명 영상',
  type: 'video',
  size: 1,
  mime: 'video/mp4',
  playMode: 'full',
  ...over,
});

/**
 * 판정 근거: 신호는 에셋의 오디오 플래그 `asset.audio`(등록 시 파일 실측 + 운영자 덮어쓰기, U84).
 *
 * **슬롯마다 문장이 다르다.** `assetPlaysAudio`는 설명 영상(`sceneOpts.video`) 전용이라
 * full 모드에서만 참이고, 오버레이는 `overlayPlaysAudio`가 따로 본다(U101b). 스팅어는
 * U102부터 소리를 내지만 **덕킹 대상은 아니다** — 효과음 레이어라 깔린 소리 위에 겹친다.
 */
describe('소리 있는 영상 판정 (U44)', () => {
  it('full 모드에서 audio 플래그가 꺼져 있지 않으면 소리가 난다', () => {
    expect(assetPlaysAudio(asset())).toBe(true);
    expect(assetPlaysAudio(asset({ audio: true }))).toBe(true);
    expect(assetPlaysAudio(asset({ audio: false }))).toBe(false);
  });

  it('playMode 미지정은 full로 본다 (등록 기본값)', () => {
    expect(assetPlaysAudio(asset({ playMode: undefined }))).toBe(true);
  });

  /**
   * 이 함수는 **설명 영상 슬롯 전용**이다 — "그 파일이 무음"이라는 뜻이 아니라
   * "`sceneOpts.video`의 덕킹 대상이 아니다"라는 뜻이다. 스팅어는 소리를 내지만 겹치기
   * 레이어라 덕킹에서 빠지고(U102), 오버레이는 `overlayPlaysAudio`가 따로 본다(U101b).
   */
  it('스팅어·오버레이는 이 판정에 들어오지 않는다 (슬롯이 다르다)', () => {
    expect(assetPlaysAudio(asset({ playMode: 'transition', audio: true }))).toBe(false);
    expect(assetPlaysAudio(asset({ playMode: 'overlay', audio: true }))).toBe(false);
  });

  it('없는 에셋은 소리도 없다', () => {
    expect(assetPlaysAudio(undefined)).toBe(false);
  });

  it('큐 항목은 자기 에셋으로 판정한다 — 매치 영상은 오버레이라 해당 없음', () => {
    const assets = [asset({ id: 'loud' }), asset({ id: 'mute', audio: false })];
    expect(cueOwnsScreen({ assetId: 'loud', assetPlayMode: 'full' }, assets)).toBe(true);
    expect(cueOwnsScreen({ assetId: 'loud', assetPlayMode: 'transition' }, assets)).toBe(false);
    expect(cueOwnsScreen({ matchEventId: 'curling' }, assets)).toBe(false);
    expect(cueOwnsScreen({}, assets)).toBe(false);
  });
});

/**
 * U117 (2026-09-05 07:0x) — "게임 소개 영상이 나올 땐 음악이 내려가야지."
 *
 * 실사고: `intro_curling.mp4`·`intro_newspaper_race.mp4`는 오디오 스트림이 아예 없는 파일이라
 * 프로브가 `audio:false`를 넣었고, 그래서 컬링·신문지 달리기 소개 영상 위로 BGM이 100%로
 * 계속 흘렀다. 소리가 있는 끈끈이 낚시·몸으로 말해요만 정상 덕킹됐다.
 *
 * 그래서 덕킹 축의 신호를 `asset.audio`에서 `playMode === 'full'`로 옮겼다. 아래 테스트가
 * 지키는 것은 **진입과 복귀가 같은 신호를 쓴다**는 계약이다 — 한쪽만 오디오 트랙을 보면
 * 내려간 음악을 되올릴 주인이 사라져 무음으로 남는다.
 *
 * U124가 이 자리에 예외를 하나 더했다: 그 영상이 **제 곡을 데려오면** 덕킹하지 않는다.
 * 여기 에셋 id는 `media:` 접두사가 없어 대본 표(`INTRO_MUSIC_DEFAULTS`)에 걸리지 않으므로,
 * 아래 문장들은 "곡이 지정되지 않은 무음 full 영상"의 계약으로 그대로 남는다 —
 * 예외 쪽 계약은 `asset-music.test.ts`가 지킨다.
 */
describe('덕킹 축은 재생 모드로 판정한다 (U117)', () => {
  const silentIntro = asset({ id: 'intro_curling', audio: false, playMode: 'full' });

  it('오디오 트랙이 없는 full 영상도 화면을 쥔다 — 덕킹 대상이다', () => {
    expect(assetOwnsScreen(silentIntro)).toBe(true);
    expect(assetPlaysAudio(silentIntro)).toBe(false);
    expect(cueOwnsScreen({ assetId: 'intro_curling', assetPlayMode: 'full' }, [silentIntro])).toBe(true);
  });

  it('무음 소개 영상 큐가 음악을 내린다 (U117 회귀 방지)', () => {
    expect(
      needsMusicDuck({
        item: { assetId: 'intro_curling', assetPlayMode: 'full' },
        assets: [silentIntro],
        musicPlaying: true,
        ducked: false,
        autoDuck: true,
      }),
    ).toBe(true);
  });

  it('내려간 음악은 그 무음 영상이 화면을 놓을 때 되올라온다 — 진입·복귀가 같은 신호다', () => {
    const s = createInitialState();
    s.assets = [silentIntro];
    const playing = reducer(s, {
      type: 'video/playFull',
      assetId: 'intro_curling',
      nextScene: 'standby',
      now: 0,
    });
    expect(fullVideoOwnsOutput(playing)).toBe(true);
    expect(fullVideoOwnsOutput(reducer(playing, { type: 'video/abort' }))).toBe(false);
  });

  it('겹치는 레이어는 그대로 빠진다 — 스팅어·오버레이는 모드로 걸러진다', () => {
    expect(assetOwnsScreen(asset({ playMode: 'transition' }))).toBe(false);
    expect(assetOwnsScreen(asset({ playMode: 'overlay' }))).toBe(false);
    expect(assetOwnsScreen(undefined)).toBe(false);
  });

  it('오디오 잠금 경고 축은 여전히 소리 유무를 본다 — 무음 영상에 빨강을 띄우지 않는다', () => {
    const s = createInitialState();
    s.assets = [silentIntro];
    const playing = reducer(s, {
      type: 'video/playFull',
      assetId: 'intro_curling',
      nextScene: 'standby',
      now: 0,
    });
    expect(videoAudioOwnsOutput(playing)).toBe(false);
  });
});

describe('덕킹이 필요한 순간 (U44)', () => {
  const assets = [asset({ id: 'loud' })];
  const base = {
    item: { assetId: 'loud', assetPlayMode: 'full' as const },
    assets,
    musicPlaying: true,
    ducked: false,
    autoDuck: true,
  };

  it('음악이 울리는 중에 소리 있는 영상으로 들어가면 내린다', () => {
    expect(needsMusicDuck(base)).toBe(true);
  });

  it('음악이 안 울리면 지연시킬 이유가 없다', () => {
    expect(needsMusicDuck({ ...base, musicPlaying: false })).toBe(false);
  });

  it('이미 내려가 있으면 다시 내리지 않는다 — 두 번 기다리게 하면 안 된다', () => {
    expect(needsMusicDuck({ ...base, ducked: true })).toBe(false);
  });

  it('자동 덕킹을 끄면 그대로 진행한다', () => {
    expect(needsMusicDuck({ ...base, autoDuck: false })).toBe(false);
  });

  it('무음 영상·비영상 큐는 지연 없이 진행한다', () => {
    expect(needsMusicDuck({ ...base, item: { assetId: 'x', assetPlayMode: 'full' } })).toBe(false);
    expect(needsMusicDuck({ ...base, item: {} })).toBe(false);
  });
});

describe('덕킹 후 지연 실행 예약 (U44)', () => {
  it('예약은 지금부터 덕 시간 뒤에 실행된다', () => {
    const p = scheduleDuckedCue(4, 1000, 2);
    expect(p.cueIndex).toBe(4);
    expect(p.runAt).toBe(3000);
    expect(duckedCueDue(p, 2999)).toBe(false);
    expect(duckedCueDue(p, 3000)).toBe(true);
  });

  it('남은 시간은 올림한 정수 초 — 0.1초가 0으로 보이면 다 된 줄 안다', () => {
    const p = scheduleDuckedCue(0, 0, 2);
    expect(duckedCueRemainingSec(p, 0)).toBe(2);
    expect(duckedCueRemainingSec(p, 1100)).toBe(1);
    expect(duckedCueRemainingSec(p, 1999)).toBe(1);
    expect(duckedCueRemainingSec(p, 2000)).toBe(0);
    expect(duckedCueRemainingSec(p, 9999)).toBe(0);
  });

  it('덕 시간이 0이면 그 자리에서 실행된다 (설정으로 지연 끄기)', () => {
    const p = scheduleDuckedCue(2, 500, 0);
    expect(duckedCueDue(p, 500)).toBe(true);
    expect(duckedCueRemainingSec(p, 500)).toBe(0);
  });
});

describe('복귀 판정 (U44 · U117)', () => {
  it('full 영상이 화면을 쥐고 있는 동안만 참이다', () => {
    const s = createInitialState();
    s.assets = [asset({ id: 'loud' })];
    expect(fullVideoOwnsOutput(s)).toBe(false);

    const playing = reducer(s, { type: 'video/playFull', assetId: 'loud', nextScene: null, now: 0 });
    expect(fullVideoOwnsOutput(playing)).toBe(true);

    // 끝나면(abort/idle) 곧바로 거짓 — 여기서 unduck이 나간다
    expect(fullVideoOwnsOutput(reducer(playing, { type: 'video/abort' }))).toBe(false);
  });

  it('무음 영상도 복귀 판정에 잡힌다 — U117에서 그 영상도 음악을 내리기 때문이다', () => {
    const s = createInitialState();
    s.assets = [asset({ id: 'mute', audio: false })];
    const playing = reducer(s, { type: 'video/playFull', assetId: 'mute', nextScene: null, now: 0 });
    expect(fullVideoOwnsOutput(playing)).toBe(true);
    // 같은 상태에서 오디오 잠금 축은 거짓이다 — 두 축이 갈라져 있다는 증거
    expect(videoAudioOwnsOutput(playing)).toBe(false);
  });
});

describe('덕킹 상태와 설정 (U44)', () => {
  it('duck/unduck은 재생 자체가 아니라 소리만 내린다 — 위치도 곡도 그대로다', () => {
    const s = reducer(createInitialState(), { type: 'music/play', trackId: '01', now: 0 });
    const ducked = reducer(s, { type: 'music/duck' });
    expect(ducked.music.ducked).toBe(true);
    expect(ducked.music.playing).toBe(s.music.playing);
    expect(ducked.music.trackId).toBe(s.music.trackId);
    // 명령 토큰이 오르면 display가 되감기·재로드를 한다 — 덕킹은 그런 명령이 아니다
    expect(ducked.music.commandToken).toBe(s.music.commandToken);

    const back = reducer(ducked, { type: 'music/unduck' });
    expect(back.music.ducked).toBe(false);
    expect(back.music.commandToken).toBe(s.music.commandToken);
  });

  it('이미 그 상태면 참조를 그대로 돌려준다 (헛 재렌더·방송 금지)', () => {
    const s = createInitialState();
    expect(reducer(s, { type: 'music/unduck' })).toBe(s);
    const ducked = reducer(s, { type: 'music/duck' });
    expect(reducer(ducked, { type: 'music/duck' })).toBe(ducked);
  });

  it('음악을 멈추거나 곡을 바꾸면 덕킹은 풀린다 — 내려간 채로 잊히면 안 된다', () => {
    const playing = reducer(createInitialState(), { type: 'music/play', trackId: '01', now: 0 });
    const ducked = reducer(playing, { type: 'music/duck' });
    expect(reducer(ducked, { type: 'music/stop', now: 1 }).music.ducked).toBe(false);
    expect(reducer(ducked, { type: 'music/play', trackId: '02', now: 1 }).music.ducked).toBe(false);
  });

  it('설정 기본값은 2초 · 자동 덕킹 켬이고 저장본 이상값은 되돌린다', () => {
    const s = createInitialState();
    expect(s.settings.musicDuckSec).toBe(DEFAULT_MUSIC_DUCK_SEC);
    expect(s.settings.autoDuckOnVideoAudio).toBe(true);

    const legacy = JSON.parse(serialize(s));
    delete legacy.settings.musicDuckSec;
    delete legacy.settings.autoDuckOnVideoAudio;
    const revived = deserialize(JSON.stringify(legacy));
    expect(revived.settings.musicDuckSec).toBe(DEFAULT_MUSIC_DUCK_SEC);
    expect(revived.settings.autoDuckOnVideoAudio).toBe(true);

    legacy.settings.musicDuckSec = 999;
    expect(deserialize(JSON.stringify(legacy)).settings.musicDuckSec).toBe(MUSIC_DUCK_SEC_RANGE.max);
    legacy.settings.autoDuckOnVideoAudio = false;
    expect(deserialize(JSON.stringify(legacy)).settings.autoDuckOnVideoAudio).toBe(false);
  });

  /**
   * migrate가 리셋하면 display는 덕킹을 **한 번도 보지 못한다** — 모든 방송이 그 경로로 오기
   * 때문이다(설명 영상 `video.phase`·분위기 반전과 같은 계약). 그래서 방송에서는 살려 보내고,
   * 저장본을 인수하는 control이 `resetRuntimeVideoPhase()`에서 푼다. 안 그러면 직전 리더가
   * 영상 도중 죽었을 때 인수한 창의 음악이 영영 무음으로 남는다.
   */
  it('덕킹은 방송을 타고 display까지 살아 가고, 저장본 인수에서 풀린다', () => {
    const playing = reducer(createInitialState(), { type: 'music/play', trackId: '01', now: 0 });
    const ducked = reducer(playing, { type: 'music/duck' });
    expect(deserialize(serialize(ducked)).music.ducked).toBe(true);
    expect(resetRuntimeVideoPhase(ducked).music.ducked).toBe(false);
    // 덕킹만 걸린 상태에서도 인수 리셋이 걸려야 한다 (영상 단계는 이미 idle일 수 있다)
    expect(resetRuntimeVideoPhase(playing)).toBe(playing);
  });
});

/**
 * 소리 있는 오버레이는 **BGM 위에 겹친다** (U113, 2026-09-05 06:21 사용자 지시).
 *
 * "매치 영상은 배경음악과 미디어 사운드가 함께 나오길 바라." U101b가 소리 있는 오버레이를
 * U44 덕킹 대상에 넣었던 것을 되돌린다 — 오버레이는 아래 화면을 갈아 끼우지 않고 그 위에
 * 얹히는 레이어이고, 스팅어(U102)와 같은 이유로 BGM이 계속 흘러야 한다.
 *
 * 되돌리는 것은 **덕킹 축 하나**다. 오버레이 소리 자체(`overlayPlaysAudio` → `overlayMuted`,
 * U101)는 그대로 살아 있다 — 아래 첫 두 테스트가 그 축을 잡아 둔다.
 */
describe('소리 있는 오버레이는 덕킹 대상이 아니다 (U113)', () => {
  const ov = (over: Partial<AssetMeta> = {}): AssetMeta =>
    asset({ id: 'match', name: '매치 영상', playMode: 'overlay', ...over });

  it('오버레이 에셋도 audio 플래그를 그대로 따른다', () => {
    expect(overlayPlaysAudio(ov())).toBe(true);
    expect(overlayPlaysAudio(ov({ audio: true }))).toBe(true);
    expect(overlayPlaysAudio(ov({ audio: false }))).toBe(false);
    expect(overlayPlaysAudio(undefined)).toBe(false);
  });

  it('슬롯 문장은 갈라져 있다 — full·transition 에셋은 이 판정에 안 들어온다', () => {
    expect(overlayPlaysAudio(asset({ playMode: 'full', audio: true }))).toBe(false);
    expect(overlayPlaysAudio(asset({ playMode: 'transition', audio: true }))).toBe(false);
    // 반대 방향도 막혀 있다 — 설명 영상 판정이 오버레이를 주워 담지 않는다
    expect(assetPlaysAudio(ov({ audio: true }))).toBe(false);
  });

  it('소리 있는 오버레이 큐도 음악을 내리지 않는다 — 큐가 붙잡히지 않는다 (U113)', () => {
    const assets = [ov({ id: 'loudOv' }), ov({ id: 'muteOv', audio: false })];
    expect(cueOwnsScreen({ assetId: 'loudOv', assetPlayMode: 'overlay' }, assets)).toBe(false);
    expect(cueOwnsScreen({ assetId: 'muteOv', assetPlayMode: 'overlay' }, assets)).toBe(false);
    // full 갈래는 그대로다 — 되돌린 것은 오버레이 하나뿐이다
    expect(cueOwnsScreen({ assetId: 'loud', assetPlayMode: 'full' }, [asset({ id: 'loud' })])).toBe(true);
  });

  it('매치 큐는 실행 시점 해석과 무관하게 덕킹을 부르지 않는다 (U113)', () => {
    const assets = [ov({ id: 'loudOv' }), ov({ id: 'muteOv', audio: false })];
    expect(cueOwnsScreen({ matchEventId: 'curling' }, assets)).toBe(false);
    // 파일이 큐에 박혀 있어도 마찬가지 — 어느 파일이 나가든 답은 거짓이다
    expect(cueOwnsScreen({ matchEventId: 'curling', assetId: 'loudOv' }, assets)).toBe(false);
  });

  it('복귀 판정은 오버레이를 보지 않는다 — 매치 영상 위로 BGM이 계속 흐른다 (U113)', () => {
    const s = createInitialState();
    s.assets = [ov({ id: 'loudOv' })];

    const playing = reducer(s, { type: 'overlay/play', assetId: 'loudOv', holdEndFrame: true, now: 0 });
    expect(playing.sceneOpts.overlayVideo.assetId).toBe('loudOv');
    // 소리 있는 오버레이가 화면을 쥐고 있어도 덕킹 축은 그것을 보지 않는다
    expect(fullVideoOwnsOutput(playing)).toBe(false);
    expect(videoAudioOwnsOutput(playing)).toBe(false);

    const gone = reducer(playing, { type: 'scene/set', scene: 'standby' });
    expect(gone.sceneOpts.overlayVideo.active).toBe(false);
    expect(fullVideoOwnsOutput(gone)).toBe(false);
  });

  it('무음 오버레이(승리 영상)도 음악을 건드리지 않는다', () => {
    const s = createInitialState();
    s.assets = [ov({ id: 'winner', audio: false })];
    const playing = reducer(s, { type: 'overlay/play', assetId: 'winner', holdEndFrame: true, now: 0 });
    expect(fullVideoOwnsOutput(playing)).toBe(false);
  });

  /**
   * 분위기 반전은 U102부터 이미 덕킹 밖이었다. U113으로 오버레이 전체가 밖으로 나가면서
   * 같은 자리에 모였다 — 예외가 아니라 규칙이 됐다.
   */
  it('분위기 반전 오버레이도 덕킹 판정에 들어가지 않는다', () => {
    const s = createInitialState();
    s.assets = [ov({ id: 'mood-asset', audio: true })];
    const mood = reducer(s, { type: 'mood/start', assetId: 'mood-asset' });
    expect(mood.sceneOpts.overlayVideo.assetId).toBe('mood-asset');
    expect(fullVideoOwnsOutput(mood)).toBe(false);
  });

  /** full 설명 영상의 덕킹·복귀는 U44 그대로 살아 있다 — 되돌린 범위가 오버레이뿐임을 잡는다 */
  it('full 설명 영상은 여전히 덕킹을 부르고 복귀 판정을 쥔다 (U44 회귀 방지)', () => {
    const s = createInitialState();
    s.assets = [asset({ id: 'loudFull', playMode: 'full', audio: true })];
    const playing = reducer(s, {
      type: 'video/playFull',
      assetId: 'loudFull',
      nextScene: 'standby',
      now: 0,
    });
    expect(fullVideoOwnsOutput(playing)).toBe(true);
    expect(videoAudioOwnsOutput(playing)).toBe(true);
    expect(
      needsMusicDuck({
        item: { assetId: 'loudFull', assetPlayMode: 'full' },
        assets: s.assets,
        musicPlaying: true,
        ducked: false,
        autoDuck: true,
      }),
    ).toBe(true);
  });
});
