import { describe, expect, it } from 'vitest';
import { DISPLAY_NAME_KEY, assistantTitle, readDisplayName, rememberDisplayName } from './display-name';

function fakeStorage(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    map: m,
  };
}

describe('assistant display name', () => {
  it('greets by name, else falls back to the product name', () => {
    expect(assistantTitle('Sample Voice')).toBe('I am Sample Voice.');
    expect(assistantTitle('  Sample ')).toBe('I am Sample.');
    expect(assistantTitle(null)).toBe('OpenJarvis');
    expect(assistantTitle('', 'OpenJarvis Desktop')).toBe('OpenJarvis Desktop');
    expect(assistantTitle('x'.repeat(41))).toBe('OpenJarvis');
  });

  it('remembers a served name and reads it back; blanks and failures are ignored', () => {
    const s = fakeStorage();
    rememberDisplayName('Sample Voice', s);
    expect(s.map.get(DISPLAY_NAME_KEY)).toBe('Sample Voice');
    expect(readDisplayName(s)).toBe('Sample Voice');
    rememberDisplayName('   ', s);
    expect(readDisplayName(s)).toBe('Sample Voice');
    expect(readDisplayName(null)).toBeNull();
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(readDisplayName(broken)).toBeNull();
    expect(() => rememberDisplayName('Sample', broken)).not.toThrow();
  });
});
