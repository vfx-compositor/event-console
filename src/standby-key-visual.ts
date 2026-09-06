export const MAIN_STANDBY_ASSET_ID = 'media:main_standby.jpeg';

export function standbyKeyVisualId(current: string | null, assetIds: string[]): string | null {
  if (current) return current;
  return assetIds.includes(MAIN_STANDBY_ASSET_ID) ? MAIN_STANDBY_ASSET_ID : null;
}
