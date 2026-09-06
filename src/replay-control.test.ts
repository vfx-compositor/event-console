// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { replayControlState } from './control/launcher';
import { formatReplayRate, isReplayOwner, shouldRecordReplay } from './replay-ring';
import { REPLAY_DEFAULTS } from './state';

const controlSource = readFileSync(new URL('./control.ts', import.meta.url), 'utf8');
const topbarSource = readFileSync(new URL('./control/topbar.ts', import.meta.url), 'utf8');
const launcherSource = readFileSync(new URL('./control/launcher.ts', import.meta.url), 'utf8');
const settingsSource = readFileSync(new URL('./control/tab-settings.ts', import.meta.url), 'utf8');
const displaySource = readFileSync(new URL('./display.ts', import.meta.url), 'utf8');
const controlCss = readFileSync(new URL('./styles/control.css', import.meta.url), 'utf8');

const READY = {
  playing: false,
  scene: 'live',
  enabled: true,
  bufferedSec: 10,
  replaySec: REPLAY_DEFAULTS.sec,
  rate: REPLAY_DEFAULTS.rate,
};

describe('리플레이 버튼 상태 (Q5)', () => {
  it('중계 화면 + 켬 + 버퍼가 차면 누를 수 있다', () => {
    const view = replayControlState(READY);
    expect(view.disabled).toBe(false);
    expect(view.label).toBe('⏪ 리플레이');
    expect(view.buffer).toBe('버퍼 10초');
  });

  it('재생 중에는 라이브 복귀로 바뀌고 언제나 누를 수 있다', () => {
    const view = replayControlState({ ...READY, playing: true, scene: 'score', bufferedSec: 0 });
    expect(view.label).toBe('■ 라이브 복귀');
    expect(view.disabled).toBe(false);
  });

  it.each([
    ['중계 화면이 아니면', { scene: 'score' }, '중계 화면'],
    ['설정이 꺼져 있으면', { enabled: false }, '꺼져 있습니다'],
    ['버퍼가 1초 미만이면', { bufferedSec: 0 }, '되감을 화면이 아직 없습니다'],
  ])('%s 비활성이고 이유를 툴팁에 적는다', (_label, patch, reason) => {
    const view = replayControlState({ ...READY, ...patch });
    expect(view.disabled).toBe(true);
    expect(view.tip).toContain(reason);
  });

  it('누를 수 있을 때의 툴팁은 되감기 길이와 배속을 그대로 읽어 준다', () => {
    const view = replayControlState({ ...READY, replaySec: 6, rate: 0.25 });
    expect(view.tip).toContain('마지막 6초');
    expect(view.tip).toContain('0.25배속');
    // 소리가 나가지 않는다는 사실을 그 자리에서 알린다 (오디오 계약)
    expect(view.tip).toContain('소리는 나가지 않습니다');
  });

  it('배속 표기는 배지·상단 칩과 같은 포맷터를 쓴다', () => {
    for (const rate of [0.25, 0.5, 0.75, 1]) {
      expect(replayControlState({ ...READY, rate }).tip).toContain(
        `${formatReplayRate(rate)}배속`,
      );
    }
    // 화이트리스트 밖 값이 새어 들어와도 세 자리가 같은 문자열을 보인다
    expect(replayControlState({ ...READY, rate: 0.3333333 }).tip).toContain('0.33배속');
  });

  it('버퍼 칩은 내림한 정수 초로 표시한다', () => {
    expect(replayControlState({ ...READY, bufferedSec: 7.9 }).buffer).toBe('버퍼 7초');
    expect(replayControlState({ ...READY, bufferedSec: -3 }).buffer).toBe('버퍼 0초');
  });
});

describe('control 배선 (Q5)', () => {
  it('단축키 R이 버튼과 같은 toggleReplay()를 부른다', () => {
    expect(controlSource).toMatch(/R:\s*\(\)\s*=>\s*toggleReplay\(\)/);
    expect(launcherSource).toContain('ctx.toggleReplay()');
  });

  it('display 이벤트 세 갈래를 각각 받는다', () => {
    expect(controlSource).toContain("/^replay-ended:(\\d+)$/");
    expect(controlSource).toContain("live/replayEnded");
    expect(controlSource).toContain("name === 'replay-unavailable'");
    expect(controlSource).toContain("/^replay-buffer:(\\d+)$/");
  });

  it('단축키 Shift+R이 [지금부터] 반쪽과 같은 toggleReplayMark()를 부른다 (U85)', () => {
    expect(controlSource).toMatch(/'Shift\+R':\s*\(\)\s*=>\s*toggleReplayMark\(\)/);
    expect(launcherSource).toContain('ctx.toggleReplayMark()');
    expect(launcherSource).toContain('ctx.clearReplayMark()');
    // 단축키 표에도 올린다 — 화면에 없는 키는 현장에서 존재하지 않는 것과 같다
    expect(settingsSource).toContain("['Shift+R'");
  });

  it('되감을 것이 없다는 보고에는 토스트와 정지를 함께 낸다', () => {
    const branch = controlSource.slice(
      controlSource.indexOf("name === 'replay-unavailable'"),
      controlSource.indexOf("const replayBuffer ="),
    );
    expect(branch).toContain('toast(');
    expect(branch).toContain("type: 'live/replayStop'");
  });

  it('버퍼 보고는 값이 바뀔 때만 다시 그린다 (매초 전체 재렌더 방지)', () => {
    const branch = controlSource.slice(
      controlSource.indexOf('const replayBuffer ='),
      controlSource.indexOf("if (name === 'audio-locked'"),
    );
    expect(branch).toContain('if (next !== replayBufferSec)');
  });

  it('토글은 거절 사유를 전부 토스트로 말한다 — 눌렀는데 아무 일도 없는 상태를 만들지 않는다', () => {
    const fn = controlSource.slice(
      controlSource.indexOf('function toggleReplay()'),
      controlSource.indexOf('const ctx: Ctx = {'),
    );
    expect(fn).toContain('중계 화면에서만');
    expect(fn).toContain('꺼져 있습니다');
    expect(fn).toContain('되감을 화면이 아직 없습니다');
    expect(fn).toContain("type: 'live/replay'");
    expect(fn).toContain("type: 'live/replayStop'");
  });
});

/**
 * U85 — 사용자 지적 "지금 리플레이 끝날 때 스팅어가 안 나오거든".
 *
 * 되감기가 끝까지 돌아 display가 `replay-ended:<token>`을 보고하는 자연 종료도, 운영자가
 * `R`로 끊는 정지도 **같은 입구**(`playReplayWithStinger`)를 지난다. 컷이 실제로 일어나는
 * 시각은 display가 `transition-switch:<token>`을 보고한 프레임이다 — 스팅어가 화면을
 * 덮은 순간(`switchAtSec`, 기본 에셋은 0.65초)이고, `transition/switched`와 한 배열로 나가
 * 방송이 한 번만 돈다.
 */
describe('나가는 컷 스팅어 (U85)', () => {
  it('자연 종료 보고를 스팅어 입구로 보낸다 — 예전처럼 곧바로 dispatch하지 않는다', () => {
    const branch = controlSource.slice(
      controlSource.indexOf('const replayEnded ='),
      controlSource.indexOf("if (name === 'replay-unavailable'"),
    );
    expect(branch).toContain("playReplayWithStinger({ type: 'live/replayEnded'");
    expect(branch).not.toMatch(/dispatch\(\{\s*type:\s*'live\/replayEnded'/);
  });

  it('운영자 정지도 같은 입구를 그대로 쓴다 (U81에서 이미 감싸고 있던 경로)', () => {
    const fn = controlSource.slice(
      controlSource.indexOf('function toggleReplay()'),
      controlSource.indexOf('function toggleReplayMark()'),
    );
    expect(fn).toContain("playReplayWithStinger({ type: 'live/replayStop' })");
  });

  it('컷은 transition-switch 프레임에 switched와 한 배열로 나간다 (방송 1회)', () => {
    const branch = controlSource.slice(
      controlSource.indexOf('const transitionSwitch ='),
      controlSource.indexOf('const transitionEnded ='),
    );
    expect(branch).toContain('takeReplayUnderStinger(token)');
    expect(branch).toContain('dispatch(replay ? [switched, replay] : switched)');
  });

  it('transition-ended 안전망이 보류분을 흘려보낸다 — 운영자가 누른 컷이 삼켜지지 않는다', () => {
    const branch = controlSource.slice(controlSource.indexOf('const transitionEnded ='));
    expect(branch.slice(0, 900)).toContain('takeReplayUnderStinger(token)');
    expect(branch.slice(0, 900)).toContain('dispatch(replay ? [finish, replay] : finish)');
  });

  /**
   * 스팅어 위에 스팅어를 얹으면 앞 전환의 switch 보고가 뒤 전환의 컷을 대신 연다.
   * 보류분이 이미 있으면 **교체**한다 — 지금 따로 내면 그 컷과 곧 터질 보류분이 둘 다 나가
   * 재생이 두 번 열린다(반쪽이 둘로 늘며 현실적인 경로가 됐다).
   */
  it('돌고 있는 전환 위에 새 스팅어를 얹지 않는다', () => {
    const fn = controlSource.slice(
      controlSource.indexOf('function playReplayWithStinger('),
      controlSource.indexOf('const ctx: Ctx = {'),
    );
    expect(fn).toContain('if (state.sceneOpts.transitionVideo.active)');
    expect(fn).toContain('if (replayUnderStinger) replayUnderStinger = { ...replayUnderStinger, action };');
    expect(fn).toContain('else dispatch(action);');
  });

  it('보류분은 액션을 통째로 들고 있다 — 토큰과 구간 길이를 되살릴 방법이 그것뿐이다', () => {
    const fn = controlSource.slice(
      controlSource.indexOf('function takeReplayUnderStinger('),
      controlSource.indexOf('const status: StatusInfo'),
    );
    expect(fn).toContain('const { action } = replayUnderStinger;');
    // 시작만 `now`를 컷 시각으로 새로 잡는다 — 나머지는 실려 온 값 그대로다
    expect(fn).toContain("action.type === 'live/replay' ? { ...action, now: Date.now() } : action");
  });

  /**
   * 스팅어가 덮기 전에 display가 화면을 놓으면 카메라가 먼저 드러나고, 스팅어는 이미 끝난
   * 컷을 덮게 된다. 동작 검사는 `replay-playback.test.ts`가 실제로 돌려 본다.
   */
  it('display는 종료 뒤 마지막 프레임을 붙잡고 컷을 기다린다', () => {
    const playbackSource = readFileSync(new URL('./replay-playback.ts', import.meta.url), 'utf8');
    const fn = playbackSource.slice(
      playbackSource.indexOf('private onEnded()'),
      playbackSource.indexOf('private fail('),
    );
    expect(fn).toContain('this.deps.video.pause();');
    // 컷이 영영 오지 않을 때를 위한 상한이 반드시 있어야 한다
    expect(fn).toContain('holdTimeoutMs');
    /**
     * `release()`는 **상한 타이머 안에서만** 불린다. 예전처럼 종료 즉시 부르면 카메라가
     * 스팅어보다 먼저 드러나 나가는 컷을 덮을 것이 없어진다.
     */
    expect(fn.indexOf('this.deps.setTimeout(')).toBeLessThan(fn.indexOf('this.release()'));
  });

  /**
   * 오디오 절대 계약 — 이 경로는 소리를 건드리지 않는다. 스팅어는 언제나 muted이고,
   * 되감기 `<video>`도 항상 muted이며, 씬이 그대로라 카메라 파킹·복원 경로가 돌지 않는다.
   */
  it('나가는 컷 경로 어디에도 볼륨·음악·덕킹이 없다', () => {
    const fns = [
      ['playReplayWithStinger', 'const ctx: Ctx = {'],
      ['toggleReplayMark', 'function clearReplayMark('],
    ] as const;
    for (const [name, end] of fns) {
      const body = controlSource.slice(
        controlSource.indexOf(`function ${name}(`),
        controlSource.indexOf(end),
      );
      expect(body).not.toMatch(/\.volume|muted|music\/|duck|Duck/);
    }
    const routing = readFileSync(new URL('./scene-routing.ts', import.meta.url), 'utf8');
    const fn = routing.slice(routing.indexOf('export function routeReplayThroughStinger('));
    expect(fn).not.toMatch(/\.volume|muted|music\/|duck|Duck/);
  });
});

describe('상단 REPLAY 칩 · 설정 · CSS (Q5)', () => {
  it('재생 중에만 상단 칩을 그리고 CSS 규칙이 있다', () => {
    expect(topbarSource).toContain('chip--replay');
    expect(topbarSource).toContain('sceneOpts.liveOverlay.replay');
    expect(controlCss).toContain('.chip--replay {');
  });

  it('JS가 만드는 리플레이 클래스는 전부 CSS 규칙을 가진다', () => {
    // U81 — 별도 `replaybox`를 걷어내고 씬 그리드의 한 칸으로 올렸다
    for (const cls of ['scene-btn--replay', 'scene-btn__buffer']) {
      expect(launcherSource).toContain(cls);
      expect(controlCss).toContain(`.${cls}`);
    }
    // 걷어낸 셀렉터가 남아 있으면 다음 사람이 되살릴 근거로 읽는다
    expect(controlCss).not.toContain('.replaybox');
  });

  it('설정 탭에 켬·끔 · 되감기 길이 · 배속 세 조작이 있고 단축키 표에 R이 있다', () => {
    expect(settingsSource).toContain('replay-enabled');
    expect(settingsSource).toContain('replay-sec');
    expect(settingsSource).toContain('replay-rate');
    expect(settingsSource).toMatch(/\['R', '슬로우 리플레이/);
  });
});

/**
 * 오디오 절대 계약 — 리플레이 `<video>`는 항상 muted이고 audio-gain 매니저를 통하지 않는다.
 * 녹화 스트림에 오디오 트랙이 아예 없으므로 볼륨을 만질 대상 자체가 없다.
 *
 * 여기 남은 것은 **소스 전체에 걸친 부정 계약**(어디에도 없어야 한다)뿐이다. 단위테스트로는
 * "이 파일 어디에도 `.volume`이 없다"를 말할 수 없다. 재생 사슬의 **동작**은 grep이 아니라
 * `src/replay-playback.test.ts`가 실제로 돌려 본다.
 */
describe('리플레이 오디오 계약 (Q5)', () => {
  const block = displaySource.slice(
    displaySource.indexOf('const replayEl = document.createElement'),
    displaySource.indexOf('/** 카메라 재생 —'),
  );

  it('재생 엘리먼트는 muted로 만든다', () => {
    expect(block).toContain('replayEl.muted = true');
  });

  it('어디에서도 replayEl의 volume을 쓰지 않고 audio-gain에 등록하지 않는다', () => {
    expect(displaySource).not.toMatch(/replayEl\.volume/);
    expect(displaySource).not.toMatch(/gatedMedia[^\n]*replayEl/);
    expect(displaySource).not.toMatch(/registerMedia\(\s*replayEl/);
  });

  it('녹화는 비디오 트랙만 담은 스트림으로 한다', () => {
    expect(displaySource).toContain('videoOnlyStream(stream)');
  });
});

/**
 * 리뷰 #7 — 재생 사슬의 동작 검사는 `replay-playback.test.ts`로 옮겼다.
 * display.ts에 남은 것은 배선뿐이므로 여기서는 **그 배선이 실제로 걸려 있는지**만 본다.
 */
describe('display 배선 (Q5)', () => {
  it('재생 구동을 ReplayPlayback에 위임한다', () => {
    expect(displaySource).toContain("import { ReplayPlayback } from './replay-playback'");
    expect(displaySource).toContain('new ReplayPlayback({');
    expect(displaySource).toContain('replayPlayback.request(request)');
    expect(displaySource).toContain('replayPlayback.stop()');
    // 사슬을 직접 다시 짜지 않는다 — 실패 처리·정리가 두 곳으로 갈리는 것을 막는다
    expect(displaySource).not.toContain('startReplayPlayback');
  });

  it('링 수명과 주인 판정을 순수 함수로 내린다', () => {
    expect(displaySource).toContain('shouldRecordReplay({');
    expect(displaySource).toContain('isReplayOwner(location.search)');
  });
});

/**
 * 리뷰 #6 — 출력 창이 둘 이상이면 창마다 인코더가 상주하고 보고가 경쟁한다.
 * PGM 모니터 iframe(`display.html?monitor=1`)은 녹화도 재생도 하지 않는다.
 */
describe('출력 창 주인 판정 (Q5 리뷰 #6)', () => {
  it('monitor=1로 열린 창은 주인이 아니다', () => {
    expect(isReplayOwner('?monitor=1')).toBe(false);
    expect(isReplayOwner('?foo=1&monitor=1')).toBe(false);
  });

  it('평범한 출력 창은 주인이다', () => {
    expect(isReplayOwner('')).toBe(true);
    expect(isReplayOwner('?monitor=0')).toBe(true);
    expect(isReplayOwner('?scale=125')).toBe(true);
  });

  it('모니터 창은 어떤 경우에도 녹화하지 않는다', () => {
    expect(
      shouldRecordReplay({ owner: false, scene: 'live', hasStream: true, enabled: true }),
    ).toBe(false);
  });

  it('주인 창도 중계 씬 + 카메라 + 설정 켬이 모두 참일 때만 녹화한다', () => {
    const ok = { owner: true, scene: 'live', hasStream: true, enabled: true };
    expect(shouldRecordReplay(ok)).toBe(true);
    expect(shouldRecordReplay({ ...ok, scene: 'score' })).toBe(false);
    expect(shouldRecordReplay({ ...ok, hasStream: false })).toBe(false);
    expect(shouldRecordReplay({ ...ok, enabled: false })).toBe(false);
  });
});

/**
 * 버퍼 보고는 값이 바뀌면 즉시, 그 외에는 1초에 한 번 같은 값을 다시 낸다.
 *
 * 같은 값을 계속 내는 것이 낭비로 보이지만 재접속 창을 위한 것이다 — 정상 상태의 버퍼는
 * 상한에 붙어 정수 초가 영영 바뀌지 않으므로, 변화 시에만 내면 그 사이 새로고침한 control이
 * 버퍼를 0으로 알고 버튼을 영영 잠근다. control은 값이 그대로면 재렌더를 건너뛴다.
 */
describe('버퍼 보고 (Q5)', () => {
  const report = displaySource.slice(
    displaySource.indexOf('function reportReplayBuffer('),
    displaySource.indexOf('function disposeReplayRing('),
  );

  it('값이 그대로여도 1초마다 다시 낸다 — 재접속 창이 최신 값을 받는다', () => {
    expect(report).toContain('now - replayBufferReportedAt < 1000');
  });

  it('링을 새로 만들면 첫 값이 반드시 나가고, 폐기하면 0을 낸다', () => {
    const sync = displaySource.slice(
      displaySource.indexOf('function disposeReplayRing('),
      displaySource.indexOf('function tickReplay('),
    );
    expect(sync).toContain('reportReplayBuffer(0, now)');
    expect(sync).toContain('replayBufferReported = -1');
  });

  it('control은 값이 바뀔 때만 다시 그린다 — 매초 보고가 전체 재렌더가 되지 않게', () => {
    const branch = controlSource.slice(
      controlSource.indexOf('const replayBuffer ='),
      controlSource.indexOf("if (name === 'audio-locked'"),
    );
    expect(branch).toContain('if (next !== replayBufferSec)');
  });
});
