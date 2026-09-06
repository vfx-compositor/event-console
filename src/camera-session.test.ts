import { describe, expect, it, vi } from 'vitest';
import { cameraTransform, CameraSession } from './camera-session';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function stream() {
  const stop = vi.fn();
  return { value: { getTracks: () => [{ stop }] } as unknown as MediaStream, stop };
}

describe('카메라 세션', () => {
  it('첫 getUserMedia 요청이 끝나기 전 반복 ensure를 해도 스트림을 한 번만 요청한다', async () => {
    const pending = deferred<MediaStream>();
    const request = vi.fn(() => pending.promise);
    const ready = vi.fn();
    const camera = new CameraSession(request, ready, vi.fn());

    const first = camera.ensure(null);
    const second = camera.ensure(null);
    const third = camera.ensure(null);

    expect(request).toHaveBeenCalledTimes(1);
    const next = stream();
    pending.resolve(next.value);
    await Promise.all([first, second, third]);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(camera.stream).toBe(next.value);
  });

  it('로딩 중 장치가 바뀌면 늦게 도착한 이전 스트림을 즉시 종료한다', async () => {
    const firstPending = deferred<MediaStream>();
    const secondPending = deferred<MediaStream>();
    const request = vi
      .fn<() => Promise<MediaStream>>()
      .mockReturnValueOnce(firstPending.promise)
      .mockReturnValueOnce(secondPending.promise);
    const ready = vi.fn();
    const camera = new CameraSession(request, ready, vi.fn());

    const first = camera.ensure('cam-a');
    const second = camera.ensure('cam-b');
    const stale = stream();
    const current = stream();
    firstPending.resolve(stale.value);
    secondPending.resolve(current.value);
    await Promise.all([first, second]);

    expect(stale.stop).toHaveBeenCalledTimes(1);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(ready).toHaveBeenCalledWith(current.value);
    expect(camera.stream).toBe(current.value);
  });

  it('기본값은 오디오 트랙을 요청하지 않는다 (하울링 방지)', async () => {
    const next = stream();
    const request = vi.fn(async () => next.value);
    const camera = new CameraSession(request, vi.fn(), vi.fn());

    await camera.ensure('cam-a');

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('cam-a', false);
    expect(camera.audio).toBe(false);
  });

  it('deviceId가 같아도 audio 플래그가 바뀌면 재협상하고 이전 스트림을 종료한다', async () => {
    const silent = stream();
    const loud = stream();
    const request = vi
      .fn<(deviceId: string | null, audio: boolean) => Promise<MediaStream>>()
      .mockResolvedValueOnce(silent.value)
      .mockResolvedValueOnce(loud.value);
    const ready = vi.fn();
    const camera = new CameraSession(request, ready, vi.fn());

    await camera.ensure('cam-a', false);
    expect(camera.stream).toBe(silent.value);

    // 같은 장치라도 오디오 트랙 유무가 다르면 다른 스트림이다 — 재협상해야 한다
    await camera.ensure('cam-a', true);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith('cam-a', true);
    expect(silent.stop).toHaveBeenCalledTimes(1);
    expect(camera.stream).toBe(loud.value);
    expect(camera.audio).toBe(true);
    expect(ready).toHaveBeenCalledTimes(2);
  });

  it('audio·deviceId가 모두 그대로면 재협상하지 않는다', async () => {
    const next = stream();
    const request = vi.fn(async () => next.value);
    const camera = new CameraSession(request, vi.fn(), vi.fn());

    await camera.ensure('cam-a', true);
    await camera.ensure('cam-a', true);
    await camera.ensure('cam-a', true);

    expect(request).toHaveBeenCalledTimes(1);
    expect(next.stop).not.toHaveBeenCalled();
  });

  it('audio 토글 로딩 중 늦게 도착한 이전 스트림도 즉시 종료한다', async () => {
    const firstPending = deferred<MediaStream>();
    const secondPending = deferred<MediaStream>();
    const request = vi
      .fn<() => Promise<MediaStream>>()
      .mockReturnValueOnce(firstPending.promise)
      .mockReturnValueOnce(secondPending.promise);
    const ready = vi.fn();
    const camera = new CameraSession(request, ready, vi.fn());

    const first = camera.ensure('cam-a', false);
    const second = camera.ensure('cam-a', true);
    const stale = stream();
    const current = stream();
    firstPending.resolve(stale.value);
    secondPending.resolve(current.value);
    await Promise.all([first, second]);

    expect(stale.stop).toHaveBeenCalledTimes(1);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(ready).toHaveBeenCalledWith(current.value);
    expect(camera.stream).toBe(current.value);
  });

  it('좌우·상하 반전을 독립적으로 합성한다', () => {
    expect(cameraTransform(false, false)).toBe('scale(1, 1)');
    expect(cameraTransform(true, false)).toBe('scale(-1, 1)');
    expect(cameraTransform(false, true)).toBe('scale(1, -1)');
    expect(cameraTransform(true, true)).toBe('scale(-1, -1)');
  });
});
