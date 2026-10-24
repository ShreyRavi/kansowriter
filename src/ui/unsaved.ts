/**
 * What the open editor holds that storage doesn't, for the root ErrorBoundary: it renders after
 * the editor is gone, so the editor registers a getter here while it is mounted.
 */
type UnsavedProvider = () => string | null;

let provider: UnsavedProvider | null = null;

/** Register (or, with null, clear) the getter; returns a cleanup that clears only this one. */
export function setUnsavedProvider(p: UnsavedProvider | null): () => void {
  provider = p;
  return () => {
    if (provider === p) provider = null;
  };
}

/** The unsaved text, or null when everything shown is saved (or nothing is registered). */
export function unsavedText(): string | null {
  try {
    return provider?.() ?? null;
  } catch {
    return null;
  }
}
