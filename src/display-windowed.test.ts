// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { outputMuted } from './audio-gain';
import {
  USER_MUTE_AUTO_HINT,
  USER_MUTE_CHIP,
  USER_MUTE_CHIP_TIP,
  USER_MUTE_KEY,
  effectiveUserMute,
  isUserMuteEvent,
  parseStoredUserMute,
  storedUserMuteValue,
  userMuteButtonHidden,
  userMuteChipVisible,
  userMuteEvent,
  userMuteHint,
  userMuteLabel,
  userMuteTip,
} from './display-windowed';
import { audioLockLevel } from './audio-lock';
import { holdEndFrameLocked, HOLD_END_FRAME_LOCK_TIP } from './control/tab-assets';

const display = readFileSync(new URL('./display.ts', import.meta.url), 'utf8');
const control = readFileSync(new URL('./control.ts', import.meta.url), 'utf8');
const topbar = readFileSync(new URL('./control/topbar.ts', import.meta.url), 'utf8');
const tabAssets = readFileSync(new URL('./control/tab-assets.ts', import.meta.url), 'utf8');
const sync = readFileSync(new URL('./sync.ts', import.meta.url), 'utf8');
const shell = readFileSync(new URL('../display.html', import.meta.url), 'utf8');
const displayCss = readFileSync(new URL('./styles/display.css', import.meta.url), 'utf8');
const controlCss = readFileSync(new URL('./styles/control.css', import.meta.url), 'utf8');

/**
 * 00:14 지시("전체화면이 아닐 땐 절대 소리가 안 나게")로 자동 무음을 만들었다가 00:36에
 * 되돌렸다 — "창 모드일 땐 음소거 버튼이 보이고 누를 수 있게." 아무도 누르지 않은 규칙이
 * 소리를 끄면, 리허설에서 창을 띄워 소리를 확인하는 평범한 동작이 불가능해진다.
 */
describe('창 모드 음소거는 자동이 아니라 버튼이다 (U88 재정정)', () => {
  it('전체화면이 아니라는 사실만으로는 아무것도 꺼지지 않는다', () => {
    expect(effectiveUserMute(false, false, false)).toBe(false);
    expect(outputMuted({ monitor: false, userMuted: false, assetMuted: false })).toBe(false);
  });

  it('운영자가 눌렀을 때만 꺼진다', () => {
    expect(effectiveUserMute(true, false, false)).toBe(true);
  });

  it('자동 무음의 흔적이 남아 있지 않다', () => {
    for (const source of [display, control, topbar, sync]) {
      expect(source).not.toContain('windowedMute');
      expect(source).not.toContain('audio-windowed');
      expect(source).not.toContain('audio-fullscreen');
    }
  });
});

describe('출력 음소거 진리표 (U88)', () => {
  const rows: [boolean, boolean, boolean, boolean][] = [
    // monitor, userMuted, assetMuted, expected
    [false, false, false, false], // 평범한 출력 창 · 소리 있는 소스 → 유일하게 소리가 난다
    [false, false, true, true], // 소스 자체가 무음(에셋 audio:false·카메라 설정 끔 등)
    [false, true, false, true], // 운영자가 이 창을 음소거했다
    [false, true, true, true],
    [true, false, false, true], // 모니터 (U72)
    [true, false, true, true],
    [true, true, false, true],
    [true, true, true, true],
  ];

  it.each(rows)(
    'monitor=%s userMuted=%s assetMuted=%s → muted=%s',
    (monitor, userMuted, assetMuted, expected) => {
      expect(outputMuted({ monitor, userMuted, assetMuted })).toBe(expected);
    },
  );

  it('세 축 중 하나라도 서면 무음이다 — 소리는 전부 통과했을 때만 난다', () => {
    const audible = rows.filter(([, , , muted]) => !muted);
    expect(audible).toHaveLength(1);
    expect(audible[0].slice(0, 3)).toEqual([false, false, false]);
  });
});

/**
 * 전체화면인 창은 정의상 프로젝터로 나가는 창이다. 무음으로 나가는 것이 가장 나쁜 실패이므로
 * 음소거는 거기서 저절로 풀린다. 기억된 선택은 지우지 않는다.
 */
describe('전체화면 자동 해제 (U88)', () => {
  it('전체화면에서는 기억된 선택이 있어도 소리가 나간다', () => {
    expect(effectiveUserMute(true, true, false)).toBe(false);
  });

  it('창 모드로 돌아오면 기억된 선택이 되살아난다', () => {
    const wish = true;
    expect(effectiveUserMute(wish, true, false)).toBe(false);
    expect(effectiveUserMute(wish, false, false)).toBe(true);
  });

  it('모니터는 이 축에 들어오지 않는다 — monitor 축이 이미 전부 끈다', () => {
    expect(effectiveUserMute(true, false, true)).toBe(false);
  });

  it('display가 브라우저 이벤트로 감지한다 — Esc·창 버튼이 토글 함수를 거치지 않는다', () => {
    expect(display).toContain("document.addEventListener('fullscreenchange', () => syncUserMute());");
    expect(display).toContain('displayFullscreen = Boolean(document.fullscreenElement);');
  });

  it('부팅에서 한 번 확정한다 — 새로고침한 창이 기억을 되살린다', () => {
    expect(display).toContain('syncUserMute(true);');
  });

  it('control에 보내는 값은 기억이 아니라 실제로 걸린 음소거다', () => {
    expect(display).toContain('const name = userMuteEvent(userMuted);');
  });
});

/**
 * **계약 잠금.** 다섯 엘리먼트(음악 덱 2 · 설명 영상 · 오버레이 · 카메라)의 `muted`가
 * 헬퍼 하나를 거치지 않으면, 음소거를 켜고 끌 때 그 한 자리만 소리가 남거나 끊긴다.
 */
describe('display의 muted 단일 경로 (U88)', () => {
  it('`.muted =` 직접 쓰기는 헬퍼 안과 언제나 무음인 붙박이 그림뿐이다', () => {
    const writes = [...display.matchAll(/(\w+)\.muted = ([^\n;]+)/g)].map((m) => ({
      target: m[1],
      value: m[2],
    }));
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) {
      // `el.muted = outputMuted({...})` — 헬퍼 본문. 그리고 오디오 트랙이 없는 두 붙박이:
      // 리플레이(녹화 스트림은 비디오 트랙뿐)와 다크 프레임(대기 화면과 같은 무음 알파 webm, U118).
      const ok =
        (write.target === 'el' && write.value.startsWith('outputMuted(')) ||
        (write.target === 'replayEl' && write.value === 'true') ||
        (write.target === 'liveFrameVideoEl' && write.value === 'true');
      expect([write.target, write.value, ok]).toEqual([write.target, write.value, true]);
    }
  });

  it('출력 미디어는 전부 setOutputMuted를 거친다', () => {
    for (const target of ['el', 'camEl', 'videoEl', 'overlayVideoEl']) {
      expect(display).toContain(`setOutputMuted(${target},`);
    }
  });

  it('헬퍼는 세 축을 그대로 audio-gain에 넘긴다', () => {
    expect(display).toContain(
      'el.muted = outputMuted({ monitor: MONITOR, userMuted, assetMuted });',
    );
  });

  it('토글은 muted만 다시 계산하고 램프에는 손대지 않는다', () => {
    const body = display.slice(display.indexOf('function refreshOutputMute()'));
    const fn = body.slice(0, body.indexOf('\n}'));
    expect(fn).toContain('setOutputMuted(el, assetMuteWish.get(el) ?? false)');
    // 게인·램프를 여기서 만지면 진행 중이던 페이드 위에 두 번째 곡선이 겹친다
    expect(fn).not.toMatch(/rampGain|setGain|\.volume/);
  });
});

/**
 * **실측 사고 잠금.** 빌드본에서 `#mute-btn`을 눌렀을 때 음악 덱 둘은 꺼졌는데
 * `video.video-el`(그 시점 idle · `src` 없음)만 `muted: false`로 남았다.
 * 원인은 재계산이 `assetMuteWish` 표만 돌았다는 것 — `applyVideoAudioPolicy`는 재생 진입에서야
 * 처음 돌므로 아직 표에 없는 엘리먼트가 통째로 빠졌다. 토글 **직후** 재생이 시작되면 첫 프레임이
 * 소리를 내고 나서야 꺼진다.
 */
describe('재계산은 표가 아니라 엘리먼트 목록을 돈다 (U88 실측 정정)', () => {
  it('토글 재계산이 다섯 출력 미디어를 전부 훑는다', () => {
    const list = display.slice(display.indexOf('function outputMediaElements()'));
    const fn = list.slice(0, list.indexOf('\n}'));
    for (const target of ['musicDecks[0].el', 'musicDecks[1].el', 'videoEl', 'overlayVideoEl', 'camEl']) {
      expect(fn).toContain(target);
    }
    // 리플레이는 영구 muted이고 오디오 트랙 자체가 없다 — 목록에 넣으면 주인이 둘이 된다
    expect(fn).not.toContain('replayEl');
    expect(display).toContain('for (const el of outputMediaElements())');
  });

  it('표에 없는 엘리먼트는 assetMuted:false로 보되, 음소거 중이면 그래도 꺼진다', () => {
    // `assetMuteWish.get(el) ?? false` — 기록이 없을 때의 값
    const missing: boolean | undefined = undefined;
    const assetMuted = missing ?? false;
    expect(assetMuted).toBe(false);
    // 음소거 중이면 소스가 멀쩡해도 muted다 (이 자리가 사고의 정확한 지점이다)
    expect(outputMuted({ monitor: false, userMuted: true, assetMuted })).toBe(true);
    // 해제하면 원래대로 소리가 난다 — 기록이 없다고 영구 음소거로 굳지 않는다
    expect(outputMuted({ monitor: false, userMuted: false, assetMuted })).toBe(false);
  });

  it('표에 기록이 있으면 그 값이 이긴다 — 무음 에셋이 해제로 살아나지 않는다', () => {
    const recorded: boolean | undefined = true;
    const assetMuted = recorded ?? false;
    expect(outputMuted({ monitor: false, userMuted: false, assetMuted })).toBe(true);
  });
});

describe('음소거 버튼 (U88)', () => {
  it('셸에 #fs-btn과 나란히 있다', () => {
    expect(shell).toContain('<button id="mute-btn" type="button" aria-pressed="false" hidden>');
    expect(shell.indexOf('id="mute-btn"')).toBeLessThan(shell.indexOf('id="fs-btn"'));
  });

  it('#fs-btn과 같은 표시 규칙에 전체화면 한 겹을 더한다', () => {
    // fs-btn이 안 보이는 자리(모니터·운영 크롬 감춘 씬)에서는 이 버튼도 없다
    expect(userMuteButtonHidden(true, false)).toBe(true);
    // 전체화면에서는 누를 것이 없어야 한다
    expect(userMuteButtonHidden(false, true)).toBe(true);
    expect(userMuteButtonHidden(true, true)).toBe(true);
    // 창 모드 + fs-btn이 보이는 자리에서만 보인다
    expect(userMuteButtonHidden(false, false)).toBe(false);
  });

  it('display가 fsBtn.hidden을 그대로 넘긴다 — 조건을 복제하지 않는다', () => {
    expect(display).toContain('muteBtn.hidden = userMuteButtonHidden(fsBtn.hidden, displayFullscreen);');
  });

  it('라벨은 색·형태 말고 글자로도 상태를 말한다', () => {
    expect(userMuteLabel(false)).toBe('🔊 소리 켬');
    expect(userMuteLabel(true)).toBe('🔇 음소거 중');
  });

  it('꺼져 있을 때만 전체화면 자동 해제를 라벨 옆에 붙인다', () => {
    expect(userMuteHint(true)).toBe(USER_MUTE_AUTO_HINT);
    expect(userMuteHint(false)).toBeNull();
    expect(USER_MUTE_AUTO_HINT).toContain('전체화면');
  });

  it('툴팁이 창 단위라는 것과 자동 해제를 함께 말한다', () => {
    for (const muted of [true, false]) {
      const tip = userMuteTip(muted);
      expect(tip).toContain('이 창');
      expect(tip).toContain('서브 모니터');
      expect(tip).toContain('전체화면');
    }
  });

  it('aria-pressed와 클래스가 함께 붙는다', () => {
    expect(display).toContain("muteBtn.setAttribute('aria-pressed', userMuteWish ? 'true' : 'false');");
    expect(display).toContain("muteBtn.classList.toggle('is-muted', userMuteWish);");
  });

  it('display.css에 버튼 규칙이 있다 — JS가 붙이는 클래스는 규칙이 있어야 한다', () => {
    expect(displayCss).toContain('#mute-btn {');
    expect(displayCss).toContain('#mute-btn[hidden]');
    expect(displayCss).toContain('#mute-btn.is-muted');
    expect(displayCss).toContain('.mute-btn__hint');
  });
});

/**
 * 창 단위 선택이다. `localStorage`면 다음에 열리는 **진짜 출력 창**이 남의 음소거를
 * 물려받아 프로젝터가 무음으로 나간다. 방송하면 두 창이 서로의 소리를 끈다.
 */
describe('창 단위 기억 (U88)', () => {
  it('sessionStorage 키를 쓴다', () => {
    expect(USER_MUTE_KEY).toBe('nsdh.console.display.userMute');
    expect(display).toContain('sessionStorage.getItem(USER_MUTE_KEY)');
    expect(display).toContain('sessionStorage.setItem(USER_MUTE_KEY, storedUserMuteValue(muted))');
  });

  it('localStorage로 새지 않는다', () => {
    expect(display).not.toContain('localStorage.setItem(USER_MUTE_KEY');
    expect(display).not.toContain('localStorage.getItem(USER_MUTE_KEY');
  });

  it('저장·복원이 왕복한다', () => {
    for (const muted of [true, false]) {
      expect(parseStoredUserMute(storedUserMuteValue(muted))).toBe(muted);
    }
  });

  it('저장본이 없거나 모르는 값이면 소리가 나는 쪽이 기본이다', () => {
    expect(parseStoredUserMute(null)).toBe(false);
    expect(parseStoredUserMute(undefined)).toBe(false);
    expect(parseStoredUserMute('')).toBe(false);
    expect(parseStoredUserMute('true')).toBe(false);
  });

  it('저장소 접근 예외를 삼킨다 — 사생활 모드에서 기능이 죽지 않는다', () => {
    const read = display.slice(display.indexOf('function readStoredUserMute()'));
    expect(read.slice(0, 240)).toContain('catch');
    const write = display.slice(display.indexOf('function writeStoredUserMute('));
    expect(write.slice(0, 240)).toContain('catch');
  });
});

describe('음소거 신호 — 출력 창과 조작 패널 (U88)', () => {
  it('sync 프로토콜에 두 이벤트가 추가되어 있다', () => {
    expect(sync).toContain("| 'audio-user-muted'");
    expect(sync).toContain("| 'audio-user-unmuted'");
  });

  it('이벤트 이름은 음소거 여부에서 나온다', () => {
    expect(userMuteEvent(true)).toBe('audio-user-muted');
    expect(userMuteEvent(false)).toBe('audio-user-unmuted');
    expect(isUserMuteEvent('audio-user-muted')).toBe(true);
    expect(isUserMuteEvent('audio-user-unmuted')).toBe(true);
    expect(isUserMuteEvent('audio-locked')).toBe(false);
  });

  it('display는 변화와 3초 주기 재통보 두 곳에서 보낸다', () => {
    expect(display).toContain('reportUserMuteState();');
    expect(display).toContain('reportUserMuteState(true);');
    // 모니터는 보고하지 않는다 — 애초에 이 버튼이 없다
    expect(display).toMatch(
      /function reportUserMuteState\(force = false\): void \{[^}]*if \(MONITOR\) return;/s,
    );
  });

  it('control은 로컬 플래그만 세우고 값이 같으면 다시 그리지 않는다', () => {
    expect(control).toContain('let displayUserMuted: boolean | null = null;');
    expect(control).toContain('if (isUserMuteEvent(name)) {');
    expect(control).toContain('status.displayUserMuted = displayUserMuted;');
    const branch = control.slice(control.indexOf('if (isUserMuteEvent(name)) {'));
    expect(branch.slice(0, 400)).toContain('if (displayUserMuted !== next) {');
  });

  it('창 단위 선택이라 상태 원장에도 방송에도 오르지 않는다', () => {
    // display는 `emit`으로 알리기만 한다 — 상태 액션을 내지 않는다
    expect(display).not.toMatch(/type: 'settings\/[^']*[Mm]ute/);
    expect(control).not.toMatch(/dispatch\([^)]*[Uu]serMute/);
  });
});

describe('상단 칩 순수 상태 (U88)', () => {
  it('출력 창이 음소거 중이라고 **보고했을 때만** 뜬다', () => {
    expect(userMuteChipVisible(true)).toBe(true);
    expect(userMuteChipVisible(false)).toBe(false);
  });

  it('아직 보고가 없으면 뜨지 않는다 — 모르는 것을 경고로 칠하지 않는다', () => {
    expect(userMuteChipVisible(null)).toBe(false);
    expect(userMuteChipVisible(undefined)).toBe(false);
  });

  it('topbar가 그 판정과 문구를 그대로 쓴다', () => {
    expect(topbar).toContain('userMuteChipVisible(ctx.status.displayUserMuted)');
    expect(topbar).toContain('USER_MUTE_CHIP');
    expect(topbar).toContain('USER_MUTE_CHIP_TIP');
    expect(USER_MUTE_CHIP).toBe('출력 창 음소거 중');
    expect(USER_MUTE_CHIP_TIP).toContain('음소거 중');
    expect(USER_MUTE_CHIP_TIP).toContain('F로 전체화면');
  });

  it('칩 스타일은 기존 경고 칩을 그대로 쓴다 — 새 클래스를 만들지 않는다', () => {
    expect(controlCss).toContain('.chip--warn {');
    const chip = topbar.slice(topbar.indexOf('userMuteChipVisible(ctx.status.displayUserMuted)'));
    expect(chip.slice(0, 300)).toContain("class: 'chip chip--warn'");
  });

  /**
   * 음소거는 운영자가 **누른 상태**다. 자동재생 잠금 배너의 `critical`이 여기 걸리면
   * 고칠 것 없는 빨강이 상시로 떠 진짜 잠금을 가린다.
   */
  it('음소거가 audioLockLevel을 critical로 올리지 않는다', () => {
    // 잠기지 않은 창은 음악이 울리는 중이어도 `none`이다 — 음소거는 이 함수의 입력이 아니다
    expect(audioLockLevel(false, true, true)).toBe('none');
    expect(audioLockLevel(null, true, true)).toBe('none');
    // control은 두 값을 별도 변수로 들고 있다
    expect(control).toContain('let audioLocked: boolean | null = null;');
    expect(control).toContain('let displayUserMuted: boolean | null = null;');
    // 음소거 보고가 audioLocked를 건드리지 않는다
    const branch = control.slice(control.indexOf('if (isUserMuteEvent(name)) {'));
    expect(branch.slice(0, 400)).not.toContain('audioLocked =');
  });
});

describe('대본 아웃트로 영상의 끝 프레임 유지 잠금 (U88)', () => {
  it('아웃트로 표에 있는 파일만 잠긴다', () => {
    expect(holdEndFrameLocked('media:olympic_intro_v001.mp4')).toBe(true);
    expect(holdEndFrameLocked('media:event_intro.mp4')).toBe(false);
    // 운영자가 직접 올린 에셋은 파일 이름 키가 아니다
    expect(holdEndFrameLocked('a1b2c3d4')).toBe(false);
  });

  it('aria-disabled로 막는다 — 네이티브 disabled면 툴팁이 뜨지 않는다', () => {
    expect(tabAssets).toContain('const locked = holdEndFrameLocked(a.id);');
    expect(tabAssets).toContain("{ 'aria-disabled': 'true', 'aria-pressed': 'false' }");
    expect(tabAssets).toContain(' is-locked');
    expect(tabAssets).not.toMatch(/asset-hold[\s\S]{0,400}disabled:\s*true/);
  });

  it('클릭은 상태를 바꾸지 않고 이유를 토스트로 답한다', () => {
    const click = tabAssets.slice(tabAssets.indexOf('if (locked) {'));
    expect(click.slice(0, 200)).toContain('toast(HOLD_END_FRAME_LOCK_TIP');
    expect(click.slice(0, 200)).toContain('return;');
  });

  it('툴팁과 토스트가 같은 문장이다', () => {
    expect(HOLD_END_FRAME_LOCK_TIP).toContain('대본 고정 아웃트로');
    expect(HOLD_END_FRAME_LOCK_TIP).toContain('5초 오디오 페이드');
    expect(tabAssets).toContain('tip: locked\n');
  });

  it('control.css에 잠긴 세그 버튼 규칙이 있다', () => {
    expect(controlCss).toContain('.seg__btn.is-locked {');
  });
});
