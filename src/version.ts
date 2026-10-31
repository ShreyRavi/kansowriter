/**
 * The build's version: the git commit it was built from, injected by vite.config.ts as
 * `__COMMIT_SHA__` (VERCEL_GIT_COMMIT_SHA, else `git rev-parse HEAD`, else 'dev'). Shown in the
 * homepage footer and the ⌘K palette; the macOS About window can reuse these constants.
 */
declare const __COMMIT_SHA__: string | undefined;

export const SOURCE_URL = 'https://github.com/ShreyRavi/kansowriter';

const SHA = /^[0-9a-f]{7,40}$/;

/** The commit to stamp: the first well-formed sha of the candidates (lowercased), else 'dev'. */
export function resolveCommitSha(...candidates: (string | null | undefined)[]): string {
  for (const c of candidates) {
    const s = c?.trim().toLowerCase();
    if (s && SHA.test(s)) return s;
  }
  return 'dev';
}

export interface VersionInfo {
  /** the full sha, or 'dev' when the build didn't know its commit */
  sha: string;
  /** 7 characters ('dev' for an unknown commit) */
  short: string;
  /** the commit on GitHub; null for 'dev' */
  commitUrl: string | null;
}

export function versionInfo(sha: string): VersionInfo {
  const s = resolveCommitSha(sha);
  if (s === 'dev') return { sha: 'dev', short: 'dev', commitUrl: null };
  return { sha: s, short: s.slice(0, 7), commitUrl: `${SOURCE_URL}/commit/${s}` };
}

export const VERSION = versionInfo(typeof __COMMIT_SHA__ === 'string' ? __COMMIT_SHA__ : 'dev');
/** "v 1a2b3c4" (or "dev") */
export const VERSION_LABEL = VERSION.commitUrl ? `v ${VERSION.short}` : 'dev';
