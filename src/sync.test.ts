// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDisplaySync } from './sync';
import { LS_KEY, createInitialState, serialize } from './state';

const displaySource = readFileSync(new URL('./display.ts', import.meta.url), 'utf8');
const controlSource = readFileSync(new URL('./control.ts', import.meta.url), 'utf8');
const controlCss = readFileSync(new URL('./styles/control.css', import.meta.url), 'utf8');
const displayCss = readFileSync(new URL('./styles/display.css', import.meta.url), 'utf8');

/**
 * vitest 환경이 node라 BroadcastChannel·localStorage·window가 없다.
 * `createDisplaySync`가 실제로 만지는 표면만 세워 두고, **무엇을 만졌는지** 기록한다.
 */
interface Harness {
  posted: unknown[];
  written: string[];
  intervals: number;
  restore(): void;
}

function harness(): Harness {
  const posted: unknown[] = [];
  const written: string[] = [];
  const store = new Map<string, string>();
  store.set(LS_KEY, serialize(createInitialState()));
  let intervals = 0;

  const g = globalThis as unknown as Record<string, unknown>;
  const saved = {
    BroadcastChannel: g.BroadcastChannel,
    localStorage: g.localStorage,
    window: g.window,
  };

  g.BroadcastChannel = class {
    onmessage: ((ev: unknown) => void) | null = null;
    postMessage(msg: unknown) {
      posted.push(msg);
    }
    close() {}
  };
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      written.push(k);
      store.set(k, v);
    },
  };
  g.window = {
    addEventListener: () => {},
    setInterval: () => {
      intervals += 1;
      return 1;
    },
    clearInterval: () => {},
  };

  return {
    posted,
    written,
    get intervals() {
      return intervals;
    },
    restore() {
      g.BroadcastChannel = saved.BroadcastChannel;
      g.localStorage = saved.localStorage;
      g.window = saved.window;
    },
  } as Harness;
}

describe('PGM 모니터 sync 계약 (U72)', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });
  afterEach(() => h.restore());

  it('일반 출력 창은 지금까지처럼 hello를 보내고 사건을 방송한다', () => {
    const sync = createDisplaySync(() => {});
    sync.emit('video-ended');
    sync.progress(1, 2);
    sync.musicProgress({ trackId: 't', t: 1, d: 2, playing: true });

    const types = h.posted.map((m) => (m as { type: string }).type);
    expect(types).toContain('hello');
    expect(types).toContain('ev');
    expect(types).toContain('vprog');
    expect(types).toContain('mprog');
    expect(h.written).toContain('nsdh.console.hello');
    expect(h.written).toContain('nsdh.console.event');
    expect(h.intervals).toBe(1);
  });

  it('모니터는 아무것도 방송하지 않는다 — hello · 사건 · 진행 보고 전부', () => {
    const sync = createDisplaySync(() => {}, { monitor: true });
    sync.emit('video-ended');
    sync.emit('camera-ok');
    sync.progress(1, 2);
    sync.musicProgress({ trackId: 't', t: 1, d: 2, playing: true });

    expect(h.posted).toEqual([]);
    expect(h.intervals).toBe(0);
  });

  it('모니터는 localStorage의 어떤 키에도 쓰지 않는다 (폴백 경로로도 새면 안 된다)', () => {
    const sync = createDisplaySync(() => {}, { monitor: true });
    sync.emit('video-ended');
    expect(h.written).toEqual([]);
  });

  it('모니터는 첫 상태를 저장본에서 직접 읽는다 — hello가 없어 되쏘아 줄 계기가 없다', async () => {
    let got = 0;
    createDisplaySync(() => {
      got += 1;
    }, { monitor: true });
    // 모듈 본문 중간에서 불리므로 마이크로태스크로 미뤄져 있다
    expect(got).toBe(0);
    await Promise.resolve();
    expect(got).toBe(1);
  });
});

describe('PGM 모니터 출력 창 가드 (U72)', () => {
  it('display가 쿼리에서 모니터 여부를 한 번만 읽는다', () => {
    expect(displaySource).toContain(
      "const MONITOR = new URLSearchParams(location.search).has('monitor');",
    );
    expect(displaySource).toContain('{ monitor: MONITOR }');
  });

  it('모니터는 카메라를 열지 않는다 — 부팅 예열과 중계 진입 두 곳 모두', () => {
    expect(displaySource).toContain(
      'if (!MONITOR) void camera.ensure(state.settings.camera.deviceId, state.settings.camera.audio);',
    );
    expect(displaySource).toContain("if (!MONITOR && (scene === 'live' || pickScene(vis) === 'live'))");
    // 카메라 자리에는 NO SIGNAL이 아니라 "여기는 모니터"라고 적는다
    expect(displaySource).toContain('buildMonitorPlaceholder()');
    expect(displaySource).toContain('카메라는 출력 창에만 나갑니다');
  });

  it('모니터는 리플레이 링을 만들지 않는다', () => {
    expect(displaySource).toContain(
      'const replayOwner = isReplayOwner(location.search) && !MONITOR;',
    );
  });

  it('모든 미디어가 매니저의 muted 경로로 꺼진다 — .volume 직접 쓰기 없음', () => {
    expect(displaySource).toContain('setOutputMuted(el, false);');
    expect(displaySource).toContain('setOutputMuted(videoEl, asset?.audio === false);');
    // 오버레이는 U101부터 `overlayMuted()` 판정을 거친다 — 컷 직후의 꼬리 램프가 도는 동안
    // 소유권만 보고 음소거하면 페이드가 들릴 자리가 없다(카메라 D5-3과 같은 사고).
    expect(displaySource).toContain('setOutputMuted(\n    overlayVideoEl,\n    overlayMuted({');
    expect(displaySource).toContain('setOutputMuted(\n    camEl,\n    cameraMuted({');
    // 전환 스팅어도 U102부터 소리를 낸다 — 판정은 설명 영상과 같은 문장(에셋 메타 하나)이다.
    expect(displaySource).toContain(
      'setOutputMuted(\n    transitionVideoEl,\n    visualState().assets.find((a) => a.id === assetId)?.audio === false,\n  );',
    );
    // 볼륨을 0으로 눌러 끄는 우회는 없다 (§3 계약: .volume은 audio-gain.ts만)
    expect(displaySource).not.toMatch(/\.volume\s*=\s*(?:0\b|MONITOR)/);
  });

  it('모니터는 오디오 잠김을 보고하지 않는다 — iframe은 언제나 잠겨 있다', () => {
    expect(displaySource).toMatch(/function reportAudioState\(force = false\): void \{[^}]*if \(MONITOR\) return;/s);
  });

  it('모니터는 운영 크롬을 감추고 rAF를 15fps로 줄인다', () => {
    expect(displaySource).toContain('fsBtn.hidden = MONITOR || operatorControlHidden;');
    expect(displaySource).toContain('const MONITOR_FRAME_MS = 1000 / 15;');
  });
});

describe('PGM 모니터 카드 (U72)', () => {
  it('좌측 열 맨 위에, 재렌더에서 살아남는 노드로 붙는다', () => {
    expect(controlSource).toContain('leftCol.append(renderPgmMonitor(ctx), leftSlot);');
    expect(controlSource).toContain('if (!shellRoot.isConnected)');
  });

  it('control.css에 16:9 · 클릭 차단 규칙이 있다', () => {
    expect(controlCss).toMatch(/\.pgm-monitor\s*\{/);
    expect(controlCss).toMatch(/\.pgm-monitor__frame\s*\{[^}]*aspect-ratio:\s*16\s*\/\s*9/s);
    expect(controlCss).toMatch(/\.pgm-monitor__frame\s*\{[^}]*pointer-events:\s*none/s);
    expect(controlCss).toMatch(/\.pgm-monitor__label\s*\{/);
    expect(controlCss).toMatch(/\.pgm-monitor__status\s*\{/);
    expect(controlCss).toMatch(/\.pgm-monitor__toggle\s*\{/);
    expect(controlCss).toMatch(/\.pgm-monitor\.is-collapsed\s+\.pgm-monitor__body\s*\{/);
    // 뼈대 감싸개도 규칙이 있어야 한다 (없으면 display:contents가 안 걸려 배치가 무너진다)
    expect(controlCss).toMatch(/\.shell__slot\s*\{[^}]*display:\s*contents/s);
  });

  it('display.css에 모니터 카메라 자리 규칙이 있다', () => {
    expect(displayCss).toMatch(/\.nosignal--monitor\s*\{/);
  });
});
