import { describe, expect, it } from 'vitest';
import { isModLetter } from './shortcuts';

const ev = (over: Partial<KeyboardEvent>) => ({ key: '', code: '', ctrlKey: false, metaKey: false, altKey: false, ...over });

describe('Ctrl/Cmd shortcuts', () => {
  it('match the letter in either case, or the physical key', () => {
    expect(isModLetter(ev({ key: 'i', code: 'KeyI', ctrlKey: true }), 'i')).toBe(true);
    expect(isModLetter(ev({ key: 'I', code: 'KeyI', ctrlKey: true }), 'i')).toBe(true); // Caps Lock
    expect(isModLetter(ev({ key: 'c', code: 'KeyI', ctrlKey: true }), 'i')).toBe(true); // another layout
    expect(isModLetter(ev({ key: 'i', code: 'KeyI', metaKey: true }), 'i')).toBe(true);
  });

  it('need Ctrl or Cmd, and not Alt', () => {
    expect(isModLetter(ev({ key: 'i', code: 'KeyI' }), 'i')).toBe(false);
    expect(isModLetter(ev({ key: 'i', code: 'KeyI', ctrlKey: true, altKey: true }), 'i')).toBe(false);
    expect(isModLetter(ev({ key: 'k', code: 'KeyK', ctrlKey: true }), 'i')).toBe(false);
  });
});
