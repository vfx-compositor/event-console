// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  AUDIO_LOCK_FIX,
  AUDIO_LOCK_OPEN_DISPLAY_TIP,
  AUDIO_LOCK_TITLE,
  audioActionBlocked,
  audioLockLevel,
  audioLockMessage,
  audioLockToast,
  classifyPlayRejection,
  pendingAudioResumePlan,
  type PendingAudioResumeInput,
} from './audio-lock';

describe('출력 오디오 잠금 경고 단계 (U48)', () => {
  it('풀려 있거나 아직 모르면 아무것도 띄우지 않는다', () => {
    expect(audioLockLevel(false, true, true)).toBe('none');
    // `null` = 출력 창이 아직 보고하지 않음. 모르는 것을 빨강으로 칠하면 창을 열 때마다
    // 경고가 떴다 사라지고, 그 다음부터 아무도 배너를 안 본다.
    expect(audioLockLevel(null, true, true)).toBe('none');
    expect(audioLockLevel(undefined, true, true)).toBe('none');
  });

  it('잠겨 있으면 소리가 없어도 상시 경고한다 — 본방 첫 영상에서 발견하면 늦다', () => {
    expect(audioLockLevel(true, false, false)).toBe('warn');
  });

  it('지금 나가야 할 소리가 있으면 강조 단계로 올린다', () => {
    expect(audioLockLevel(true, true, false)).toBe('critical');
    expect(audioLockLevel(true, false, true)).toBe('critical');
    expect(audioLockLevel(true, true, true)).toBe('critical');
  });

  it('두 단계 문구 모두 해결 방법을 담는다 — 경고만 있고 방법이 없으면 소용없다', () => {
    for (const level of ['warn', 'critical'] as const) {
      expect(audioLockMessage(level)).toContain(AUDIO_LOCK_FIX);
      expect(audioLockMessage(level)).toContain('클릭');
    }
    expect(AUDIO_LOCK_FIX).toContain('같은 브라우저 프로필');
    expect(AUDIO_LOCK_TITLE).toContain('소리');
  });

  it('문구는 출력 창 클릭과 같은 브라우저 프로필 사용을 안내한다', () => {
    expect(AUDIO_LOCK_FIX).toContain('출력 창을 한 번 클릭');
    expect(AUDIO_LOCK_FIX).toContain('같은 브라우저 프로필');
    for (const level of ['warn', 'critical'] as const) {
      expect(audioLockMessage(level)).toContain('같은 브라우저 프로필');
    }
  });

  it('[출력창 열기] 툴팁이 이 경로의 소리 위험을 미리 경고한다', () => {
    expect(AUDIO_LOCK_OPEN_DISPLAY_TIP).toContain('display.html');
    expect(AUDIO_LOCK_OPEN_DISPLAY_TIP).toContain('클릭');
    expect(AUDIO_LOCK_OPEN_DISPLAY_TIP).toContain('같은 브라우저 프로필');
  });

  it('조작 순간 토스트는 무엇이 막혔는지와 할 일을 함께 말한다', () => {
    expect(audioActionBlocked(true)).toBe(true);
    expect(audioActionBlocked(false)).toBe(false);
    expect(audioActionBlocked(null)).toBe(false);
    expect(audioLockToast('음악')).toContain('음악');
    expect(audioLockToast('영상')).toContain('영상');
    expect(audioLockToast('음악')).toContain('출력 창을 한 번 클릭');
  });
});

/**
 * 현장 증상: "오디오 영상 → 다른 탭 → 음악 조작"에서 **소리는 나가는데** 잠금 안내가 뜨고,
 * 그 뒤 오디오가 겹쳐 나왔다. 원인 절반이 여기다 — 모든 `play()` 거부를 잠금으로 셌다.
 */
describe('play() 거부 분류 (U48 후속)', () => {
  const err = (name: string): Error => Object.assign(new Error(name), { name });

  it('자동재생 정책만 잠금이다', () => {
    expect(classifyPlayRejection(err('NotAllowedError'))).toBe('autoplay-lock');
  });

  it('AbortError는 무시한다 — 씬 전환·소스 교체·배경 탭에서 정상적으로 난다', () => {
    // "play() interrupted by a new load request" / "by pause()". 이걸 잠금으로 세면
    // 소리가 멀쩡한데도 배지·배너가 뜨고, 이어지는 클릭이 재개를 돌려 소리가 겹친다.
    expect(classifyPlayRejection(err('AbortError'))).toBe('ignore');
  });

  it('그 밖의 오류는 잠금이 아니라 오류다 — 배너를 띄워 봐야 클릭으로 안 풀린다', () => {
    expect(classifyPlayRejection(err('NotSupportedError'))).toBe('error');
    expect(classifyPlayRejection(new Error('boom'))).toBe('error');
    expect(classifyPlayRejection(undefined)).toBe('error');
    expect(classifyPlayRejection('문자열 거부')).toBe('error');
  });
});

/**
 * 원인 나머지 절반: 잠금이 풀린 뒤 **상태를 보지 않고** 셋을 전부 다시 붙였다.
 * 화면에 없는 소스가 소리만 내며 지금 씬 위에 얹히는 것이 겹침의 정체다.
 */
describe('잠금 해제 후 재개 대상 (U48 후속)', () => {
  const base: PendingAudioResumeInput = {
    shownScene: 'video',
    videoPaused: false,
    cameraAudioEnabled: true,
    cameraParked: false,
    musicPlaying: true,
    musicTrackId: 'bgm-1',
  };

  it('설명 영상은 `video` 씬에서만 되살린다', () => {
    expect(pendingAudioResumePlan(base).video).toBe(true);
    // 다른 씬으로 넘어간 뒤 클릭하면 화면에 없는 영상 소리가 지금 씬 위에 겹친다
    expect(pendingAudioResumePlan({ ...base, shownScene: 'score' }).video).toBe(false);
    expect(pendingAudioResumePlan({ ...base, shownScene: 'live' }).video).toBe(false);
  });

  it('운영자가 일부러 세워 둔 일시정지는 되살리지 않는다', () => {
    expect(pendingAudioResumePlan({ ...base, videoPaused: true }).video).toBe(false);
  });

  it('카메라는 중계 씬 + 소리 켬 + 치우지 않은 상태에서만', () => {
    const live = { ...base, shownScene: 'live' };
    expect(pendingAudioResumePlan(live).camera).toBe(true);
    // 치워 둔 동안에는 게인의 주인이 정리다 — 여기서 붙이면 페이드가 끝나자마자 소리가 산다
    expect(pendingAudioResumePlan({ ...live, cameraParked: true }).camera).toBe(false);
    // 소리 설정이 꺼져 있으면 muted라 자동재생 정책에 막힌 적이 없다 → 되살릴 것도 없다
    expect(pendingAudioResumePlan({ ...live, cameraAudioEnabled: false }).camera).toBe(false);
    expect(pendingAudioResumePlan(base).camera).toBe(false); // video 씬
  });

  it('음악은 씬과 무관하다 — 행사 BGM은 어느 씬 위에서도 울린다', () => {
    expect(pendingAudioResumePlan({ ...base, shownScene: 'standby' }).music).toBe(true);
    expect(pendingAudioResumePlan({ ...base, musicPlaying: false }).music).toBe(false);
    expect(pendingAudioResumePlan({ ...base, musicTrackId: null }).music).toBe(false);
  });

  it('덕킹 중에도 음악 재개 판정은 그대로다 — 덕킹은 곱으로 합성되는 별도 축이다', () => {
    // 여기서 목표를 낮추면 영상이 끝나 덕킹이 1로 돌아올 때 음악이 두 배로 작아진 채 남는다.
    // 이 함수는 "무엇을 되살리는가"만 정하고 게인은 tickAudioGains가 합성한다.
    expect(pendingAudioResumePlan({ ...base, shownScene: 'video' }).music).toBe(true);
  });

  it('아무것도 울릴 것이 없으면 전부 false — 클릭 한 번이 소리를 만들어 내면 안 된다', () => {
    const idle = pendingAudioResumePlan({
      shownScene: 'standby',
      videoPaused: true,
      cameraAudioEnabled: false,
      cameraParked: true,
      musicPlaying: false,
      musicTrackId: null,
    });
    expect(idle).toEqual({ video: false, camera: false, music: false });
  });
});

/**
 * 순수 함수만으로는 "출력 창이 그 함수를 실제로 쓰는가"를 고정할 수 없다.
 * 겹침 사고의 형태가 **호출 자리**에 있었으므로 그 배선을 소스로 못 박는다.
 */
describe('출력 창 배선 (U48 후속)', () => {
  const display = readFileSync(new URL('./display.ts', import.meta.url), 'utf8');

  it('세 재생 자리가 모두 거부를 분류한 뒤에 잠금을 판단한다', () => {
    // playCamera · 오버레이 · 설명 영상 — 하나라도 빠지면 그 자리만 거짓 잠금을 낸다
    expect(display.match(/classifyPlayRejection\(error\)/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('잠금 해제 재개가 계획을 거쳐서만 움직인다', () => {
    const start = display.indexOf('function resumePendingAudio(');
    expect(start).toBeGreaterThan(-1);
    const body = display.slice(start, display.indexOf('\n}\n', start));
    expect(body).toContain('pendingAudioResumePlan({');
    expect(body).toContain('if (plan.video)');
    expect(body).toContain('if (plan.camera && camEl.paused)');
    // 카메라 muted의 주인은 paint()의 cameraMuted()다. 여기서 직접 쓰면 parked 판정을
    // 건너뛰고 치워 둔 카메라의 소리를 켠다 (스트림 협상 자리의 같은 대입은 별개다).
    expect(body).not.toContain('camEl.muted =');
  });

  it('음악 페이드 인 목표가 한 곳에만 있다 — 정상 경로와 재개가 같은 함수를 쓴다', () => {
    expect(display).toContain('function fadeInMusicDeck(');
    expect(display).toContain('startMusicRamp(deck, TRACK_FULL_GAIN,');
    // 목표를 숫자로 다시 적은 자리가 남아 있으면 한쪽만 고치는 사고가 다시 난다
    expect(display).not.toMatch(/startMusicRamp\(\s*deck,\s*1\s*,/);
  });

  it('첫 제스처만으로는 재개하지 않는다 — 잠긴 적이 있어야 한다', () => {
    expect(display).toContain('const wasBlocked = needsAudioUnlock || isAudioAutoplayBlocked();');
    expect(display).toContain('if (wasBlocked) {');
    // 판정은 `userActivated = true` **앞**이어야 한다. 뒤면 언제나 false가 된다.
    expect(display.indexOf('const wasBlocked =')).toBeLessThan(
      display.indexOf('userActivated = true;\n    // 잠긴 적이 없으면'),
    );
  });
});
