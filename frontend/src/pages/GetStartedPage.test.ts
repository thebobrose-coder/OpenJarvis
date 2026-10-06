import { describe, expect, it } from 'vitest';
import { DESKTOP_TAGLINE, desktopTitle } from './GetStartedPage';

describe('desktop welcome heading', () => {
  it('uses the runtime display name, else the product name', () => {
    expect(desktopTitle('Sample Voice')).toBe('I am Sample Voice.');
    expect(desktopTitle('  Sample  ')).toBe('I am Sample.');
    expect(desktopTitle(null)).toBe('OpenJarvis Desktop');
    expect(desktopTitle('')).toBe('OpenJarvis Desktop');
    expect(DESKTOP_TAGLINE).toMatch(/I AM the machine\.$/);
  });
});
