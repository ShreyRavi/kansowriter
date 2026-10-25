import { describe, expect, it } from 'vitest';
import { DEFAULTS, sanitizeSettings } from './settings';
import { importLabel } from './backupActions';

describe('sanitizeSettings', () => {
  it('drops unknown or out-of-range stored values instead of crashing the editor', () => {
    expect(sanitizeSettings({ typeface: 'comic', textSize: 400, goal: 'x', hideChrome: 7, theme: 'night' })).toEqual({
      ...DEFAULTS,
      textSize: 25,
      theme: 'night',
    });
    expect(sanitizeSettings(null)).toEqual(DEFAULTS);
    expect(sanitizeSettings('garbage')).toEqual(DEFAULTS);
  });
});

describe('importLabel', () => {
  it('never calls a draft that differs "already here"', () => {
    expect(importLabel({ added: 0, copies: 0, skipped: 3, damaged: 0 })).toBe('Nothing new: all 3 drafts are already here');
    expect(importLabel({ added: 2, copies: 1, skipped: 1, damaged: 0 })).toBe(
      'Added 1 draft, added 1 changed draft as a copy, skipped 1 already here',
    );
    expect(importLabel({ added: 1, copies: 1, skipped: 0, damaged: 0 })).toBe('Added 1 changed draft as a copy');
    expect(importLabel({ added: 0, copies: 0, skipped: 0, damaged: 2 })).toBe('Left out 2 drafts that couldn’t be read');
    expect(importLabel({ added: 0, copies: 0, skipped: 0, damaged: 0 })).toBe('That backup has no drafts');
    expect(importLabel({ added: 0, copies: 0, skipped: 2, damaged: 1 })).toBe(
      'Nothing new: 2 are already here, left out 1 draft that couldn’t be read',
    );
  });
});
