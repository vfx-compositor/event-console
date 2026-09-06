/**
 * 중계 카메라 스트림 세션.
 *
 * `audio`는 **트랙을 요청할지 말지**를 정한다 (`camEl.muted`와 다르다).
 * 끄면 `getUserMedia`에 오디오를 아예 요청하지 않으므로 마이크 권한 프롬프트도 뜨지 않는다.
 * 기본은 off — 같은 방의 스피커 소리가 카메라 마이크로 되돌아가 하울링이 나기 때문이다.
 */
export type CameraRequest = (deviceId: string | null, audio: boolean) => Promise<MediaStream>;

export function cameraTransform(flipX: boolean, flipY: boolean): string {
  return `scale(${flipX ? -1 : 1}, ${flipY ? -1 : 1})`;
}

/** 재협상 판단 기준. deviceId와 audio 중 **하나만** 바뀌어도 다른 스트림이다. */
function sessionKey(deviceId: string | null, audio: boolean): string {
  return `${deviceId ?? ''}|${audio ? 1 : 0}`;
}

/**
 * display rAF에서 ensure()를 반복 호출해도 하나의 getUserMedia만 유지한다.
 * 장치 변경 중 늦게 도착한 이전 스트림은 바로 종료해 화면 깜빡임과 카메라 누수를 막는다.
 *
 * 비교는 **`key` 한 곳에서만** 한다(진입 가드·then·catch 3곳 전부). deviceId와 audio를 따로
 * 비교하면 세 곳 중 하나만 놓쳐도 stale 스트림이 살아남아 마이크가 계속 열려 있게 된다.
 */
export class CameraSession {
  deviceId: string | null | undefined = undefined;
  /** 현재 세션이 오디오 트랙을 요청했는가 */
  audio = false;
  stream: MediaStream | null = null;
  error = '';

  /** null = 아직 어떤 세션도 시작하지 않음. 어떤 실제 키와도 같지 않다. */
  private key: string | null = null;
  private generation = 0;
  private pending: Promise<void> | null = null;

  constructor(
    private readonly request: CameraRequest,
    private readonly onReady: (stream: MediaStream) => void,
    private readonly onError: (message: string) => void,
  ) {}

  ensure(deviceId: string | null, audio = false): Promise<void> {
    const key = sessionKey(deviceId, audio);
    if (this.key === key) {
      if (this.pending) return this.pending;
      if (this.stream || this.error) return Promise.resolve();
    } else {
      this.generation += 1;
      this.stream?.getTracks().forEach((track) => track.stop());
      this.stream = null;
      this.error = '';
      this.deviceId = deviceId;
      this.audio = audio;
      this.key = key;
    }

    const generation = ++this.generation;
    const pending = this.request(deviceId, audio)
      .then((stream) => {
        if (generation !== this.generation || this.key !== key) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        this.stream = stream;
        this.error = '';
        this.onReady(stream);
      })
      .catch((error: unknown) => {
        if (generation !== this.generation || this.key !== key) return;
        this.error = error instanceof Error ? error.message : '카메라를 열 수 없습니다';
        this.onError(this.error);
      })
      .finally(() => {
        if (generation === this.generation) this.pending = null;
      });
    this.pending = pending;
    return pending;
  }
}
