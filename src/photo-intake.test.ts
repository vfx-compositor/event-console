/**
 * `photo-intake.ts`의 **순수 로직**만 검증한다 (vitest 환경은 `node` — DOM·IndexedDB 없음).
 *
 * 여기서 잡고자 하는 실제 사고:
 *  - 복사 중인 파일을 열어 잘린 JPEG를 흡수 → 그 한 장이 영영 안 들어온다 (H5 안정화)
 *  - 실패한 파일을 무한 재시도 → 3초마다 같은 에러가 도는 좀비 폴링 (tries 상한)
 *  - 같은 파일이 두 번 들어와 사진이 중복 → 슬라이드쇼에 같은 장면이 두 번 (중복 키)
 *  - 흡수 도중 크래시로 남은 고아 blob / blob 없는 "깨진 사진" (M5 양방향 비교)
 */

import { describe, expect, it } from 'vitest';

import {
  PHOTO_BATCH_MAX,
  PHOTO_BATCH_MS,
  PHOTO_FAILED_KEEP,
  PHOTO_MAX_TRIES,
  PHOTO_STABLE_SCANS,
  abortPhotoIntake,
  classifyIntakeFile,
  comparePhotoIds,
  emptyIntakeStatus,
  intakeFiles,
  intakeGeneration,
  intakeStatus,
  isIntaking,
  pushFailed,
  scanDone,
  scanObserve,
  scanRetry,
  shouldFlushBatch,
  type IntakeDeps,
  type ScanEntry,
} from './photo-intake';
import { photoKey } from './photos';

const NONE: ReadonlySet<string> = new Set<string>();

/** 폴링 한 틱을 흉내낸다 — 같은 이름을 관측 목록대로 반복 관측한 뒤 결과를 모은다 */
function runScans(
  obs: ReadonlyArray<{ size: number; lastModified: number }>,
): { verdicts: string[]; entry: ScanEntry | undefined } {
  let entry: ScanEntry | undefined;
  const verdicts: string[] = [];
  for (const o of obs) {
    const r = scanObserve(entry, o);
    entry = r.entry;
    verdicts.push(r.verdict);
  }
  return { verdicts, entry };
}

// ---------------------------------------------------------------- H5 스캔 안정화

describe('scanObserve — 스캔 안정화 판정 (H5)', () => {
  it('처음 보이는 파일은 기록만 하고 기다린다', () => {
    const { verdicts, entry } = runScans([{ size: 100, lastModified: 10 }]);
    expect(verdicts).toEqual(['wait']);
    expect(entry).toMatchObject({ size: 100, lastModified: 10, stable: 1, tries: 0, done: false });
  });

  it('연속 2회 동일해야 처리 큐로 간다 (≈6초 안정화)', () => {
    const { verdicts, entry } = runScans([
      { size: 100, lastModified: 10 },
      { size: 100, lastModified: 10 },
    ]);
    expect(verdicts).toEqual(['wait', 'ready']);
    expect(entry?.stable).toBe(PHOTO_STABLE_SCANS);
    // ready인 순간 확정된다 — 다음 틱이 같은 파일을 또 집으면 이중 흡수가 된다
    expect(entry?.done).toBe(true);
  });

  it('size가 자라는 동안(복사 중)에는 몇 번을 봐도 ready가 되지 않는다', () => {
    const { verdicts } = runScans([
      { size: 10, lastModified: 10 },
      { size: 5000, lastModified: 10 },
      { size: 900000, lastModified: 10 },
    ]);
    expect(verdicts).toEqual(['wait', 'wait', 'wait']);
  });

  it('lastModified만 달라져도 안정화 카운트가 처음부터 다시 센다', () => {
    const { verdicts } = runScans([
      { size: 100, lastModified: 10 },
      { size: 100, lastModified: 20 },
      { size: 100, lastModified: 20 },
    ]);
    expect(verdicts).toEqual(['wait', 'wait', 'ready']);
  });

  it('복사가 끝난 뒤 안정되면 그때 ready가 된다', () => {
    const { verdicts } = runScans([
      { size: 10, lastModified: 10 },
      { size: 900000, lastModified: 12 },
      { size: 900000, lastModified: 12 },
    ]);
    expect(verdicts).toEqual(['wait', 'wait', 'ready']);
  });

  it('확정된 엔트리는 같은 참조를 돌려주고 done 판정만 한다 (getFile 하지 않는 경로)', () => {
    const done = scanDone(100, 10);
    const r = scanObserve(done, { size: 999, lastModified: 999 });
    expect(r.verdict).toBe('done');
    expect(r.entry).toBe(done);
  });

  it('불변이다 — 이전 엔트리를 변형하지 않는다', () => {
    const prev: ScanEntry = { size: 100, lastModified: 10, stable: 1, tries: 0, done: false };
    const snapshot = { ...prev };
    scanObserve(prev, { size: 100, lastModified: 10 });
    expect(prev).toEqual(snapshot);
  });

  it('NaN 크기는 0으로 정규화해 판정이 흔들리지 않는다', () => {
    const { verdicts } = runScans([
      { size: Number.NaN, lastModified: 10 },
      { size: Number.NaN, lastModified: 10 },
    ]);
    expect(verdicts).toEqual(['wait', 'ready']);
  });
});

// ---------------------------------------------------------------- 재시도 카운트

describe('scanRetry — 실패 재시도 상한 (H5)', () => {
  it('첫 실패는 확정을 풀고 안정화를 다시 기다린다', () => {
    const claimed: ScanEntry = { size: 100, lastModified: 10, stable: 2, tries: 0, done: true };
    const { entry, giveUp } = scanRetry(claimed);
    expect(giveUp).toBe(false);
    expect(entry).toMatchObject({ tries: 1, stable: 0, done: false });
  });

  it('3회째 실패에서 포기하고 다시 열지 않는다', () => {
    let entry: ScanEntry = { size: 100, lastModified: 10, stable: 2, tries: 0, done: true };
    const gaveUp: boolean[] = [];
    for (let i = 0; i < PHOTO_MAX_TRIES; i++) {
      // 실패 → 안정화 2회 → 다시 ready → 다시 실패, 를 반복한다
      const r = scanRetry(entry);
      gaveUp.push(r.giveUp);
      entry = r.entry;
      if (!r.giveUp) {
        entry = scanObserve(entry, { size: 100, lastModified: 10 }).entry;
        entry = scanObserve(entry, { size: 100, lastModified: 10 }).entry;
      }
    }
    expect(gaveUp).toEqual([false, false, true]);
    expect(entry.tries).toBe(PHOTO_MAX_TRIES);
    expect(entry.done).toBe(true);
    // 포기한 뒤에는 몇 번을 관측해도 다시 열리지 않는다
    expect(scanObserve(entry, { size: 100, lastModified: 10 }).verdict).toBe('done');
  });

  it('재시도 사이에도 tries는 보존된다 (안정화 재계산이 카운트를 지우지 않는다)', () => {
    const { entry } = scanRetry({ size: 1, lastModified: 1, stable: 2, tries: 0, done: true });
    const again = scanObserve(entry, { size: 1, lastModified: 1 }).entry;
    expect(again.tries).toBe(1);
    // 파일이 바뀌어도 tries는 유지 — "이 이름은 말썽"이라는 사실이 사라지면 무한 루프가 된다
    const changed = scanObserve(again, { size: 2, lastModified: 1 }).entry;
    expect(changed.tries).toBe(1);
  });
});

// ---------------------------------------------------------------- 배치 플러시

describe('shouldFlushBatch — 배치 dispatch 시점', () => {
  it('빈 배치는 절대 내보내지 않는다 (불필요한 저장·방송 억제)', () => {
    expect(shouldFlushBatch(0, 10_000)).toBe(false);
  });

  it('10장이 차면 시간과 무관하게 내보낸다', () => {
    expect(shouldFlushBatch(PHOTO_BATCH_MAX, 0)).toBe(true);
    expect(shouldFlushBatch(PHOTO_BATCH_MAX - 1, 0)).toBe(false);
  });

  it('500ms가 지나면 장수가 모자라도 내보낸다', () => {
    expect(shouldFlushBatch(1, PHOTO_BATCH_MS)).toBe(true);
    expect(shouldFlushBatch(1, PHOTO_BATCH_MS - 1)).toBe(false);
  });
});

// ---------------------------------------------------------------- 실패 목록

describe('pushFailed — 최근 실패 파일명', () => {
  it('같은 파일은 한 번만 남고 맨 뒤로 간다 (3회 재시도가 목록을 채우지 않게)', () => {
    let list = pushFailed([], 'a.jpg');
    list = pushFailed(list, 'b.jpg');
    list = pushFailed(list, 'a.jpg');
    expect(list).toEqual(['b.jpg', 'a.jpg']);
  });

  it(`${PHOTO_FAILED_KEEP}건을 넘으면 오래된 것부터 버린다`, () => {
    let list: string[] = [];
    for (let i = 0; i < PHOTO_FAILED_KEEP + 5; i++) list = pushFailed(list, `f${i}.jpg`);
    expect(list).toHaveLength(PHOTO_FAILED_KEEP);
    expect(list[0]).toBe('f5.jpg');
    expect(list[list.length - 1]).toBe(`f${PHOTO_FAILED_KEEP + 4}.jpg`);
  });

  it('원본 배열을 변형하지 않는다', () => {
    const src = ['a.jpg'];
    pushFailed(src, 'b.jpg');
    expect(src).toEqual(['a.jpg']);
  });
});

// ---------------------------------------------------------------- 중복 · 확장자 판정

describe('classifyIntakeFile — 흡수 전 신원 판정', () => {
  const f = (name: string, size = 1000, lastModified = 5000) => ({ name, size, lastModified });

  it('새 사진은 파일 신원 키를 id로 받아들인다', () => {
    const v = classifyIntakeFile(f('IMG_1.jpg'), NONE, NONE);
    expect(v).toEqual({ kind: 'accept', id: photoKey('IMG_1.jpg', 1000, 5000) });
  });

  it('상태에 이미 있는 사진은 중복이다', () => {
    const known = new Set([photoKey('IMG_1.jpg', 1000, 5000)]);
    expect(classifyIntakeFile(f('IMG_1.jpg'), known, NONE).kind).toBe('duplicate');
  });

  it('같은 배치 안의 중복도 잡는다 (knownIds가 아직 갱신되기 전이다)', () => {
    const batch = new Set([photoKey('IMG_1.jpg', 1000, 5000)]);
    expect(classifyIntakeFile(f('IMG_1.jpg'), NONE, batch).kind).toBe('duplicate');
  });

  it('이름만 다르고 내용이 같으면 다른 id다 (신원 키가 이름을 포함하므로)', () => {
    const known = new Set([photoKey('IMG_1.jpg', 1000, 5000)]);
    expect(classifyIntakeFile(f('사진 2.jpg'), known, NONE).kind).toBe('accept');
  });

  it('크기·수정시각 중 하나만 달라도 다른 사진으로 본다', () => {
    const known = new Set([photoKey('IMG_1.jpg', 1000, 5000)]);
    expect(classifyIntakeFile(f('IMG_1.jpg', 1001, 5000), known, NONE).kind).toBe('accept');
    expect(classifyIntakeFile(f('IMG_1.jpg', 1000, 5001), known, NONE).kind).toBe('accept');
  });

  it('HEIC는 디코드하지 않고 건너뛴다 (Chrome이 못 읽는다)', () => {
    expect(classifyIntakeFile(f('IMG_1.HEIC'), NONE, NONE)).toEqual({ kind: 'heic' });
    expect(classifyIntakeFile(f('IMG_1.heif'), NONE, NONE)).toEqual({ kind: 'heic' });
  });

  it('사진이 아닌 파일은 카운트도 하지 않는다', () => {
    for (const name of ['clip.mp4', 'memo.txt', 'noext', '.DS_Store']) {
      expect(classifyIntakeFile(f(name), NONE, NONE)).toEqual({ kind: 'ignore' });
    }
  });

  it('대문자 확장자도 사진으로 본다', () => {
    expect(classifyIntakeFile(f('IMG.JPG'), NONE, NONE).kind).toBe('accept');
    expect(classifyIntakeFile(f('shot.PNG'), NONE, NONE).kind).toBe('accept');
    expect(classifyIntakeFile(f('shot.WebP'), NONE, NONE).kind).toBe('accept');
  });
});

// ---------------------------------------------------------------- M5 무결성

describe('comparePhotoIds — 고아 blob · 깨진 사진 (M5)', () => {
  it('양쪽이 같으면 아무것도 없다', () => {
    expect(comparePhotoIds(['a', 'b'], new Set(['a', 'b']))).toEqual({ orphans: [], broken: 0 });
  });

  it('IndexedDB에만 있는 blob은 고아다 (흡수 도중 크래시의 잔해)', () => {
    expect(comparePhotoIds(['a', 'b', 'c'], new Set(['a']))).toEqual({
      orphans: ['b', 'c'],
      broken: 0,
    });
  });

  it('상태에만 있는 사진은 깨진 것이다 (display가 조용히 건너뛴다)', () => {
    expect(comparePhotoIds(['a'], new Set(['a', 'b', 'c']))).toEqual({ orphans: [], broken: 2 });
  });

  it('양쪽이 어긋나면 둘 다 센다', () => {
    expect(comparePhotoIds(['a', 'x'], new Set(['a', 'y']))).toEqual({ orphans: ['x'], broken: 1 });
  });

  it('상태가 비어 있으면 blob 전부가 고아다 (사진 전체 삭제 후 정리 경로)', () => {
    expect(comparePhotoIds(['a', 'b'], NONE)).toEqual({ orphans: ['a', 'b'], broken: 0 });
  });

  it('DB가 비어 있으면 상태의 사진이 전부 깨진 것이다', () => {
    expect(comparePhotoIds([], new Set(['a', 'b']))).toEqual({ orphans: [], broken: 2 });
  });
});

// ---------------------------------------------------------------- 초기 상태

describe('emptyIntakeStatus', () => {
  it('호출마다 새 객체다 (모듈 상태가 테스트 사이에 새지 않게)', () => {
    const a = emptyIntakeStatus();
    const b = emptyIntakeStatus();
    expect(a).not.toBe(b);
    expect(a.failed).not.toBe(b.failed);
    expect(a).toEqual(b);
  });

  it('T4 패널이 읽는 필드가 전부 들어 있다', () => {
    expect(Object.keys(emptyIntakeStatus()).sort()).toEqual(
      [
        'broken',
        'dir',
        'dirName',
        'done',
        'failed',
        'lastAddAt',
        'lastScanAt',
        'pending',
        'quota',
        'scanning',
        'skippedHeic',
        'usage',
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------- H4 세대 토큰 · M10 HEIC 카운트

/**
 * `intakeFiles`의 **디코드에 닿지 않는 경로**만 검증한다 — 여기서 잡는 사고 둘:
 *  - 리더 자리를 넘긴 뒤에도 루프가 끝까지 돌아 비리더 창이 IndexedDB에 blob을 밀어 넣는다 (H4)
 *  - 드롭한 HEIC가 폴더 스캔 누적 카운터에 섞여 패널의 `건너뜀 N`이 계속 불어난다 (M10)
 *
 * 파일 객체는 이름·크기·수정시각만 보므로(디코드 전 판정) 평범한 객체로 충분하다.
 */
function file(name: string, size = 1024, lastModified = 1): File {
  return { name, size, lastModified } as unknown as File;
}

function deps(over: Partial<IntakeDeps> = {}): IntakeDeps {
  return {
    knownIds: () => NONE,
    onBatch: () => undefined,
    onStatus: () => undefined,
    ...over,
  };
}

describe('intakeFiles — 강등 중단 (H4)', () => {
  it('abortPhotoIntake()는 세대를 올린다', () => {
    const before = intakeGeneration();
    expect(abortPhotoIntake()).toBe(before + 1);
    expect(intakeGeneration()).toBe(before + 1);
  });

  it('흡수 도중 강등되면 남은 파일을 열지 않고 aborted로 끊는다', async () => {
    let seen = 0;
    const res = await intakeFiles(
      [file('1.jpg'), file('2.jpg'), file('3.jpg')],
      deps({
        knownIds: () => {
          // 1단계(신원 판정) 도중에 자리를 넘긴 상황 — 2단계 디코드로 넘어가면 안 된다
          if (++seen === 1) abortPhotoIntake();
          return NONE;
        },
        onBatch: () => {
          throw new Error('강등된 뒤에는 배치가 나가면 안 된다');
        },
      }),
    );
    expect(res.aborted).toBe(true);
    expect(res.added).toBe(0);
    // 실패가 아니라 **시도하지 않은** 것이다 — failed에 담기면 호출부가 거짓 토스트를 띄운다
    expect(res.failed).toEqual([]);
    expect(isIntaking()).toBe(false);
  });

  it('강등이 없으면 aborted는 false다 (새 사진이 하나도 없는 정상 경로)', async () => {
    const known = new Set([photoKey('dup.jpg', 1024, 1)]);
    const res = await intakeFiles([file('dup.jpg')], deps({ knownIds: () => known }));
    expect(res).toEqual({ added: 0, skipped: 1, skippedHeic: 0, failed: [], aborted: false });
  });
});

describe('intakeFiles — HEIC 카운트 (M10)', () => {
  it('드롭한 HEIC는 이번 결과에만 담고 누적 카운터를 올리지 않는다', async () => {
    const before = intakeStatus().skippedHeic;
    const res = await intakeFiles([file('a.HEIC'), file('b.heic'), file('note.txt')], deps());
    expect(res.skippedHeic).toBe(2);
    // 'note.txt'는 사진이 아니므로 세지 않는다
    expect(res.skipped).toBe(2);
    expect(res.added).toBe(0);
    // 누적치는 폴더 스캔 전용 — 드롭을 반복해도 패널의 `건너뜀 N`이 불어나지 않는다
    expect(intakeStatus().skippedHeic).toBe(before);
  });
});
