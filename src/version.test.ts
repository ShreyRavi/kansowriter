import { describe, expect, it } from 'vitest';
import { resolveCommitSha, SOURCE_URL, VERSION, VERSION_LABEL, versionInfo } from './version';

const FULL = '0123456789abcdef0123456789abcdef01234567';

describe('version', () => {
  it('takes the first well-formed sha: Vercel’s, then git’s', () => {
    expect(resolveCommitSha(FULL, 'fedcba9')).toBe(FULL);
    expect(resolveCommitSha(undefined, FULL)).toBe(FULL);
    expect(resolveCommitSha('', `  ${FULL.toUpperCase()}\n`)).toBe(FULL);
    expect(resolveCommitSha('not-a-sha', 'abc')).toBe('dev');
    expect(resolveCommitSha()).toBe('dev');
  });

  it('shortens to 7 characters and links the commit', () => {
    expect(versionInfo(FULL)).toEqual({ sha: FULL, short: '0123456', commitUrl: `${SOURCE_URL}/commit/${FULL}` });
  });

  it('degrades to dev without a link', () => {
    expect(versionInfo('dev')).toEqual({ sha: 'dev', short: 'dev', commitUrl: null });
    expect(versionInfo('')).toEqual({ sha: 'dev', short: 'dev', commitUrl: null });
  });

  it('exports a consistent build version, whatever the commit', () => {
    if (VERSION.commitUrl) {
      expect(VERSION.short).toBe(VERSION.sha.slice(0, 7));
      expect(VERSION_LABEL).toBe(`v ${VERSION.short}`);
    } else expect(VERSION_LABEL).toBe('dev');
  });
});
