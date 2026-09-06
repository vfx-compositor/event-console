import { describe, expect, it } from 'vitest';

import { loadBundledPhotoFiles, seedBundledPhotos } from './photo-seed';

const MANIFEST_URL = 'http://console.test/photo-seed/manifest.json';

function response(body: BodyInit, contentType: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': contentType } });
}

describe('loadBundledPhotoFiles', () => {
  it('manifest의 안정된 이름과 시각으로 실제 이미지 File을 만든다', async () => {
    const fixtures = new Map<string, Response>([
      [
        MANIFEST_URL,
        response(
          JSON.stringify({
            version: 1,
            photos: [
              { file: 'scene-01.png', lastModified: 101 },
              { file: 'scene-02.jpg', lastModified: 202 },
            ],
          }),
          'application/json',
        ),
      ],
      ['http://console.test/photo-seed/scene-01.png', response(new Blob(['png']), 'image/png')],
      ['http://console.test/photo-seed/scene-02.jpg', response(new Blob(['jpg']), 'image/jpeg')],
    ]);

    const files = await loadBundledPhotoFiles(async (url) => {
      const hit = fixtures.get(String(url));
      return hit?.clone() ?? new Response(null, { status: 404 });
    }, MANIFEST_URL);

    expect(files.map(({ name, type, lastModified, size }) => ({ name, type, lastModified, size }))).toEqual([
      { name: 'scene-01.png', type: 'image/png', lastModified: 101, size: 3 },
      { name: 'scene-02.jpg', type: 'image/jpeg', lastModified: 202, size: 3 },
    ]);
  });

  it('경로 이탈·사진 아닌 파일·중복·잘못된 시각은 seed 후보에서 제외한다', async () => {
    const manifest = response(
      JSON.stringify({
        version: 1,
        photos: [
          { file: 'safe.png', lastModified: 101 },
          { file: '../secret.png', lastModified: 102 },
          { file: 'nested/secret.jpg', lastModified: 103 },
          { file: 'notes.txt', lastModified: 104 },
          { file: 'safe.png', lastModified: 105 },
          { file: 'broken.jpg', lastModified: -1 },
        ],
      }),
      'application/json',
    );

    const files = await loadBundledPhotoFiles(
      async (url) =>
        String(url) === MANIFEST_URL
          ? manifest.clone()
          : response(new Blob(['image']), 'image/png'),
      MANIFEST_URL,
    );

    expect(files.map((file) => file.name)).toEqual(['safe.png']);
  });

  it('일부 이미지가 없으면 나머지 seed는 계속 불러온다', async () => {
    const manifest = response(
      JSON.stringify({
        version: 1,
        photos: [
          { file: 'exists.webp', lastModified: 101 },
          { file: 'missing.webp', lastModified: 102 },
        ],
      }),
      'application/json',
    );

    const files = await loadBundledPhotoFiles(async (url) => {
      if (String(url) === MANIFEST_URL) return manifest.clone();
      if (String(url).endsWith('/exists.webp')) return response(new Blob(['webp']), 'image/webp');
      return new Response(null, { status: 404 });
    }, MANIFEST_URL);

    expect(files.map((file) => file.name)).toEqual(['exists.webp']);
  });
});

describe('seedBundledPhotos', () => {
  it('빈 사진함에 seed를 흡수한 첫 순간 대기 사진배경을 켠다', async () => {
    let photoCount = 0;
    let backdrop = false;
    const files = [new File(['photo'], 'scene.png', { type: 'image/png', lastModified: 101 })];

    const added = await seedBundledPhotos({
      isLeader: () => true,
      photoCount: () => photoCount,
      loadFiles: async () => files,
      intake: async (incoming) => {
        photoCount += incoming.length;
        return { added: incoming.length };
      },
      enableStandbyBackdrop: () => {
        backdrop = true;
      },
    });

    expect(added).toBe(1);
    expect(photoCount).toBe(1);
    expect(backdrop).toBe(true);
  });

  it('이미 사진이 있으면 사용자 큐와 배경 설정을 건드리지 않는다', async () => {
    let loaded = false;
    let backdrop = false;

    const added = await seedBundledPhotos({
      isLeader: () => true,
      photoCount: () => 3,
      loadFiles: async () => {
        loaded = true;
        return [];
      },
      intake: async () => ({ added: 0 }),
      enableStandbyBackdrop: () => {
        backdrop = true;
      },
    });

    expect(added).toBe(0);
    expect(loaded).toBe(false);
    expect(backdrop).toBe(false);
  });
});
