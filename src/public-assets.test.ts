// @ts-expect-error Test-only Node imports; the application has no Node runtime dependency.
import { mkdtemp, rm } from 'node:fs/promises';
// @ts-expect-error Test-only Node imports.
import { tmpdir } from 'node:os';
// @ts-expect-error Test-only Node imports.
import { dirname, join } from 'node:path';
// @ts-expect-error Test-only Node imports.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build, preview, type PreviewServer } from 'vite';
import { GAME_STEADY_IMAGES } from './scenes/game';
import { P2_STEADY_IMAGES } from './scenes/submit';
import { ATHLETE_OATH_IMAGE } from './scenes/standby';
import { DEFAULT_TEAM_LOGOS } from './logos';
import { EVENT_MARK_SRC } from './scenes/luxe-grid';
// @ts-expect-error Test-only Node imports.
import { readFileSync } from 'node:fs';

const projectRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
let outDir = '';
let server: PreviewServer | undefined;
let baseUrl = '';

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'event-console-public-assets-'));
  await build({ root: projectRoot, logLevel: 'silent', build: { outDir, emptyOutDir: true } });
  server = await preview({ root: projectRoot, logLevel: 'silent', build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
  baseUrl = server.resolvedUrls!.local[0];
}, 30_000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server!.httpServer.close(() => resolve()));
  if (outDir) await rm(outDir, { recursive: true, force: true });
}, 30_000);

describe('standalone distribution without private event assets', () => {
  it.each(['LICENSE', 'THIRD_PARTY_NOTICES.md', 'licenses/Pretendard-OFL-1.1.txt',
    'licenses/Inter-OFL-1.1.txt', 'licenses/Barlow-OFL-1.1.txt'])
  ('ships the original legal notice with the built fonts: %s', async (path) => {
    const response = await fetch(new URL(path, baseUrl));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(readFileSync(join(projectRoot, path), 'utf8'));
  });
  it.each(['index.html', 'control.html', 'display.html'])('serves %s from a clean build', async (path) => {
    const response = await fetch(new URL(path, baseUrl));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Event Console');
  });

  it('ships empty media and photo catalogs', async () => {
    const media = await fetch(new URL('media/manifest.json', baseUrl));
    const photos = await fetch(new URL('photo-seed/manifest.json', baseUrl));
    expect(media.status).toBe(200);
    expect(photos.status).toBe(200);
    expect(await media.json()).toEqual([]);
    expect(await photos.json()).toEqual({ version: 1, photos: [] });
  });

  it.each([
    './media/standby-light.svg', './media/standby-dark.svg', './media/pre_mission.svg',
    ATHLETE_OATH_IMAGE, ...Object.values(GAME_STEADY_IMAGES),
    ...Object.values(P2_STEADY_IMAGES), ...DEFAULT_TEAM_LOGOS,
  ])('serves the built-in fallback %s without optional files', async (path) => {
    const response = await fetch(new URL(path, baseUrl));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('image/svg+xml');
    expect(await response.text()).toContain('<svg');
  });

  it('uses a self-contained board mark', () => {
    expect(EVENT_MARK_SRC).toMatch(/^data:image\/svg\+xml,/);
    expect(decodeURIComponent(EVENT_MARK_SRC.split(',')[1])).toContain('<svg');
  });

  it.each(['__shot.html', '__shot-state.json', '__vis.html', 'media/main_05_light.webm',
    'media/main_05_dark.webm', 'media/private_intro.mp4', 'design/refs/broadcast/private-reference.jpg'])
  ('does not distribute private or development content: %s', async (path) => {
    expect((await fetch(new URL(path, baseUrl))).status).toBe(404);
  });
});
