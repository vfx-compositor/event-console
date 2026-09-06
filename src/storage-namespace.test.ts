import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInitialState, loadLocal, saveLocal, serialize } from './state';

afterEach(() => vi.unstubAllGlobals());

describe('Event Console keeps existing distribution storage compatibility', () => {
  it('neither restores nor overwrites the original event state on a shared origin', () => {
    const original = createInitialState();
    original.settings.title = 'Original event';
    const originalJson = serialize(original);
    const values = new Map([['y9.console.state.v1', originalJson]]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    });

    expect(loadLocal()).toBeNull();
    const standalone = createInitialState();
    standalone.settings.title = 'Independent event';
    expect(saveLocal(standalone)).toBe(true);
    expect(values.get('y9.console.state.v1')).toBe(originalJson);
    expect(values.has('nsdh.console.state.v1')).toBe(true);
    expect(loadLocal()?.settings.title).toBe('Independent event');
  });
});
