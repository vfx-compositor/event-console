export type PhotoSeedFetch = (input: string | URL) => Promise<Response>;

interface PhotoSeedEntry {
  file: string;
  lastModified: number;
}

const SEED_IMAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|webp)$/i;

function seedEntries(raw: unknown): PhotoSeedEntry[] {
  if (!raw || typeof raw !== 'object') return [];
  const photos = (raw as { photos?: unknown }).photos;
  if (!Array.isArray(photos)) return [];

  const seen = new Set<string>();
  const entries: PhotoSeedEntry[] = [];
  for (const candidate of photos) {
    if (!candidate || typeof candidate !== 'object') continue;
    const { file, lastModified } = candidate as { file?: unknown; lastModified?: unknown };
    if (typeof file !== 'string' || !SEED_IMAGE_NAME.test(file) || seen.has(file)) continue;
    if (!Number.isSafeInteger(lastModified) || Number(lastModified) < 0) continue;
    seen.add(file);
    entries.push({ file, lastModified: Number(lastModified) });
  }
  return entries;
}

function fallbackMime(file: string): string {
  if (/\.png$/i.test(file)) return 'image/png';
  if (/\.webp$/i.test(file)) return 'image/webp';
  return 'image/jpeg';
}

export async function loadBundledPhotoFiles(
  fetcher: PhotoSeedFetch,
  manifestUrl: string,
): Promise<File[]> {
  let entries: PhotoSeedEntry[];
  try {
    const manifest = await fetcher(manifestUrl);
    if (!manifest.ok) return [];
    entries = seedEntries(await manifest.json());
  } catch {
    return [];
  }

  const files: File[] = [];
  for (const entry of entries) {
    try {
      const response = await fetcher(new URL(entry.file, manifestUrl));
      if (!response.ok) continue;
      const blob = await response.blob();
      files.push(
        new File([blob], entry.file, {
          type: blob.type || fallbackMime(entry.file),
          lastModified: entry.lastModified,
        }),
      );
    } catch {
      // 현장 복사에서 한 장이 누락돼도 나머지 seed까지 버리지는 않는다.
    }
  }
  return files;
}

export interface SeedBundledPhotosDeps {
  isLeader(): boolean;
  photoCount(): number;
  loadFiles(): Promise<File[]>;
  intake(files: readonly File[]): Promise<{ added: number }>;
  enableStandbyBackdrop(): void;
}

export async function seedBundledPhotos(deps: SeedBundledPhotosDeps): Promise<number> {
  if (!deps.isLeader() || deps.photoCount() > 0) return 0;

  const files = await deps.loadFiles();
  // manifest를 읽는 동안 리더가 바뀌거나 사용자가 먼저 사진을 넣었으면 seed가 끼어들지 않는다.
  if (!files.length || !deps.isLeader() || deps.photoCount() > 0) return 0;

  const result = await deps.intake(files);
  if (result.added > 0 && deps.isLeader()) deps.enableStandbyBackdrop();
  return result.added;
}
