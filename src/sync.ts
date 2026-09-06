/**
 * 창 간 동기화 — 리더는 control, display는 순수 구독자. (SPEC P5)
 *
 * 경로 2개:
 *  1) 기존 BroadcastChannel 이름 — 저장 데이터와 열린 구버전 창의 호환을 위해 유지
 *  2) localStorage 'storage' 이벤트 — BroadcastChannel이 없거나 막힌 환경 폴백.
 *     control이 어차피 매 변경마다 localStorage에 저장(P4)하므로 폴백 비용이 0이다.
 *
 * display가 늦게 열려도 hello → control이 현재 상태를 되쏘아 즉시 따라잡는다.
 *
 * 환경 개조 메모: 같은 origin·브라우저 프로필이 전제다. OBS Browser Source는 외부
 * Chrome/Edge와 저장소를 공유하지 않는다. 기본 OBS 연결은 기존 display 창 캡처이며,
 * 직접 연결을 추가하면 상태뿐 아니라 IndexedDB 미디어 전달과 재연결도 설계해야 한다.
 * docs/AI_CUSTOMIZATION.md, docs/OPERATION_TIPS.md 참고.
 */

import { LS_KEY, deserialize, serialize } from './state';
import type { AppState } from './types';

const CHANNEL = 'nsdh-console';
const HELLO_KEY = 'nsdh.console.hello';
const EVENT_KEY = 'nsdh.console.event';

/** display가 control에게 알리는 런타임 이벤트 (상태 변경 권한은 control에만 있다) */
export type DisplayEvent =
  | 'video-ended'
  | 'camera-ok'
  | 'camera-fail'
  /** 전환 영상이 실제로 재생을 시작해 이 토큰에 바인딩됐다 — control의 stall 워치독 기준점 */
  | `transition-bound:${number}`
  | `transition-switch:${number}`
  | `transition-ended:${number}`
  /** 설명 영상(full) 검정 페이드 3단계 상태 머신 — 각 단계 완료 보고 (§4-3) */
  | `fullvideo-covered:${number}`
  | `fullvideo-held:${number}`
  | `fullvideo-tail:${number}`
  | `fullvideo-revealed:${number}`
  | `overlay-held:${number}`
  | `overlay-ended:${number}`
  | `scenefade-switched:${number}`
  | `scenefade-finished:${number}`
  | `music-ended:${string}`
  | `music-error:${string}`
  /**
   * 페이드 아웃이 끝나 **실제로 멈춘** 위치 보고 — `music-paused-at:<commandToken>:<초>`.
   *
   * 일시정지 명령 시각과 소리가 멎는 시각은 `musicFadeSec`만큼 벌어진다. 그 사이 재생은
   * 계속되므로 control이 명령 시점에 적어 둔 `positionSec`은 그만큼 뒤처진다. 그대로 두면
   * display 새 창이 그 값으로 seek해 페이드 길이만큼 뒤로 점프한다.
   */
  | `music-paused-at:${number}:${number}`
  /** 출력 창 오디오 autoplay 정책 상태 — control 상단 경고 칩용 (§4-4) */
  | 'audio-locked'
  | 'audio-ok'
  /**
   * 운영자가 **출력 창에서** 음소거 버튼을 눌렀는가 (U88).
   *
   * `audio-locked`와 **별도 축**이다 — 저쪽은 브라우저 정책이 막은 사고이고 이쪽은 운영자가
   * 누른 상태다. 한 이벤트로 합치면 조작 패널이 "고칠 것 없는 잠금"을 빨강으로 띄운다.
   * 창 단위 선택이라 상태 원장에는 오르지 않는다 — control은 알림만 받아 칩을 띄운다.
   */
  | 'audio-user-muted'
  | 'audio-user-unmuted'
  /** 슬로우 리플레이(Q5) 재생이 끝까지 돌았다 — 토큰이 맞을 때만 라이브로 복귀한다 */
  | `replay-ended:${number}`
  /**
   * 되감을 것이 없다 — 링이 없거나(카메라 없음·MediaRecorder 미지원) 버퍼가 1초 미만.
   * control이 토스트를 띄우고 `live/replayStop`으로 지시를 거둔다.
   */
  | 'replay-unavailable'
  /** 지금 되감을 수 있는 길이(정수 초, 최대 `replaySec`). 녹화 중 1초에 한 번 */
  | `replay-buffer:${number}`;

/** 영상 재생 진행 상황 (패널 진행 바용). 상태가 아니라 순간 값이라 방송만 한다. */
export interface VideoProgress {
  /** 현재 재생 위치(초) */
  t: number;
  /** 전체 길이(초). 알 수 없으면 0 */
  d: number;
}

export interface MusicProgress {
  trackId: string | null;
  t: number;
  d: number;
  playing: boolean;
}

type Msg =
  | { type: 'state'; payload: string }
  | { type: 'hello' }
  | { type: 'ev'; name: DisplayEvent }
  | { type: 'vprog'; t: number; d: number }
  | { type: 'mprog'; trackId: string | null; t: number; d: number; playing: boolean };

function openChannel(): BroadcastChannel | null {
  try {
    return typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL) : null;
  } catch {
    return null;
  }
}

export interface ControlSync {
  publish(state: AppState): void;
  /** display 창이 붙어 있다고 확인된 마지막 시각 (0이면 미확인) */
  lastHelloAt(): number;
  close(): void;
}

export function createControlSync(
  getState: () => AppState,
  onEvent: (name: DisplayEvent) => void = () => {},
  onProgress: (p: VideoProgress) => void = () => {},
  /**
   * 이 창이 아직 상태를 방송해도 되는가 (control 리더 락).
   *
   * control이 두 개 열리면 display의 3초 `hello`에 **양쪽 모두** 응답해
   * localStorage와 채널 state를 서로 다른 씬으로 번갈아 덮어쓴다. 방송 지점이
   * 여러 곳(hello 응답 / storage 폴백 / 명시적 publish)이라 가드는 publish 안에 둔다.
   */
  canPublish: () => boolean = () => true,
  onMusicProgress: (p: MusicProgress) => void = () => {},
): ControlSync {
  const bc = openChannel();
  let helloAt = 0;
  let lastEventStamp = '';

  const publish = (state: AppState) => {
    if (!canPublish()) return;
    const payload = serialize(state);
    try {
      localStorage.setItem(LS_KEY, payload);
    } catch {
      /* 용량 초과 등 — 방송은 계속 시도한다 */
    }
    bc?.postMessage({ type: 'state', payload } satisfies Msg);
  };

  if (bc) {
    bc.onmessage = (ev: MessageEvent<Msg>) => {
      if (ev.data?.type === 'hello') {
        helloAt = Date.now();
        publish(getState());
      } else if (ev.data?.type === 'ev') {
        helloAt = Date.now();
        onEvent(ev.data.name);
      } else if (ev.data?.type === 'vprog') {
        helloAt = Date.now();
        onProgress({ t: ev.data.t, d: ev.data.d });
      } else if (ev.data?.type === 'mprog') {
        helloAt = Date.now();
        onMusicProgress({
          trackId: ev.data.trackId,
          t: ev.data.t,
          d: ev.data.d,
          playing: ev.data.playing,
        });
      }
    };
  }

  // 폴백 경로: display가 HELLO_KEY / EVENT_KEY를 갱신하면 storage 이벤트로 감지
  window.addEventListener('storage', (ev) => {
    if (ev.key === HELLO_KEY) {
      helloAt = Date.now();
      publish(getState());
    } else if (ev.key === EVENT_KEY && ev.newValue && ev.newValue !== lastEventStamp) {
      lastEventStamp = ev.newValue;
      helloAt = Date.now();
      try {
        onEvent(JSON.parse(ev.newValue).name as DisplayEvent);
      } catch {
        /* 무시 */
      }
    }
  });

  return { publish, lastHelloAt: () => helloAt, close: () => bc?.close() };
}

export interface DisplaySync {
  emit(name: DisplayEvent): void;
  /** 재생 진행 보고 (BroadcastChannel 전용 — 폴백 경로는 쓰지 않는다. 없으면 진행 바만 비활성) */
  progress(t: number, d: number): void;
  musicProgress(progress: MusicProgress): void;
  close(): void;
}

export interface DisplaySyncOptions {
  /**
   * 이 창이 **PGM 모니터**인가 (U72 — 조작 패널 좌측의 `display.html?monitor=1` iframe).
   *
   * 모니터는 상태를 **받기만** 한다. 기존 내부 프로토콜은 그대로이고 추가되는 메시지도 없다 —
   * 보내는 쪽을 덜 보낼 뿐이라 계약("프로토콜은 추가만") 안에 있다.
   *
   * 왜 덜 보내야 하는가:
   *  1. `emit` — 모니터가 `video-ended`를 한 번 더 쏘면 control이 영상 종료를 **두 번** 처리한다.
   *  2. `hello` — control은 마지막 hello로 "출력 창이 붙어 있다"를 판정한다. 모니터가 인사하면
   *     진짜 출력 창이 닫혀 있어도 연결됨으로 표시되어, 프로젝터에 아무것도 안 나가는 것을
   *     모른 채 진행하게 된다. **가장 위험한 오보라 여기가 핵심이다.**
   *  3. 진행 보고(`vprog`·`mprog`) — 두 창이 번갈아 보내면 패널의 진행 바가 앞뒤로 튄다.
   *
   * localStorage의 `HELLO_KEY`·`EVENT_KEY`에도 쓰지 않는다(폴백 경로로 같은 사고가 난다).
   * 상태는 부팅 때 `LS_KEY`에서 한 번 읽고, 그 뒤로는 BroadcastChannel의 `state`만 따른다.
   */
  monitor?: boolean;
}

export function createDisplaySync(
  onState: (state: AppState) => void,
  opts: DisplaySyncOptions = {},
): DisplaySync {
  const monitor = opts.monitor === true;
  const bc = openChannel();

  if (bc) {
    bc.onmessage = (ev: MessageEvent<Msg>) => {
      if (ev.data?.type === 'state') {
        try {
          onState(deserialize(ev.data.payload));
        } catch {
          /* 잘못된 페이로드는 무시 — 마지막 정상 상태를 유지 */
        }
      }
    };
  }

  window.addEventListener('storage', (ev) => {
    if (ev.key === LS_KEY && ev.newValue) {
      try {
        onState(deserialize(ev.newValue));
      } catch {
        /* 무시 */
      }
    }
  });

  const hello = () => {
    bc?.postMessage({ type: 'hello' } satisfies Msg);
    try {
      localStorage.setItem(HELLO_KEY, String(Date.now()));
    } catch {
      /* 무시 */
    }
  };

  let iv = 0;
  if (monitor) {
    /**
     * 모니터의 첫 상태는 저장본에서 직접 읽는다 — hello를 보내지 않으므로 control이
     * 현재 상태를 되쏘아 줄 계기가 없고, 다음 조작이 있을 때까지 초기 상태로 서 있게 된다.
     *
     * 마이크로태스크로 미룬다: `createDisplaySync`는 display.ts 모듈 본문 중간에서 불리는데,
     * 콜백이 곧바로 그리기를 시도하면 아래쪽에서 만드는 레이어들이 아직 없다.
     */
    queueMicrotask(() => {
      try {
        const raw = localStorage.getItem(LS_KEY);
        if (raw) onState(deserialize(raw));
      } catch {
        /* 저장본이 없거나 깨졌다 — 방송을 기다린다 */
      }
    });
  } else {
    hello();
    // control이 아직 안 떠 있을 수 있으므로 3초마다 재시도 (연결 상태 점 근거도 됨)
    iv = window.setInterval(hello, 3000);
  }

  return {
    emit(name: DisplayEvent) {
      if (monitor) return;
      bc?.postMessage({ type: 'ev', name } satisfies Msg);
      try {
        localStorage.setItem(EVENT_KEY, JSON.stringify({ name, ts: Date.now() }));
      } catch {
        /* 무시 */
      }
    },
    progress(t: number, d: number) {
      if (monitor) return;
      bc?.postMessage({ type: 'vprog', t, d } satisfies Msg);
    },
    musicProgress(progress: MusicProgress) {
      if (monitor) return;
      bc?.postMessage({ type: 'mprog', ...progress } satisfies Msg);
    },
    close() {
      if (iv) window.clearInterval(iv);
      bc?.close();
    },
  };
}
