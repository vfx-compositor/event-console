/**
 * 숫자 카운트업 애니메이션 — DOM 교체와 무관하게 값만 보간한다.
 * (씬 HTML은 상태가 바뀔 때만 교체되므로, 시간에 따라 변하는 숫자는 tick에서 직접 써넣는다.)
 */

interface Track {
  from: number;
  to: number;
  t0: number;
}

const tracks = new Map<string, Track>();

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/** key별로 target을 향해 durMs 동안 보간된 현재값 */
export function animatedNumber(key: string, target: number, now: number, durMs = 600): number {
  const cur = tracks.get(key);
  if (!cur) {
    tracks.set(key, { from: target, to: target, t0: now });
    return target;
  }
  if (cur.to !== target) {
    const present = valueOf(cur, now);
    tracks.set(key, { from: present, to: target, t0: now });
    return present;
  }
  return valueOf(cur, now);

  function valueOf(t: Track, n: number): number {
    const p = Math.min(1, Math.max(0, (n - t.t0) / durMs));
    return t.from + (t.to - t.from) * easeOutCubic(p);
  }
}

export function resetAnimations(prefix?: string): void {
  if (!prefix) {
    tracks.clear();
    return;
  }
  for (const k of [...tracks.keys()]) if (k.startsWith(prefix)) tracks.delete(k);
}
