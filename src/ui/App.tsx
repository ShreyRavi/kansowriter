import { lazy, Suspense } from 'react';

// Two chunks by path: the letter reader (1A) stands alone (no drafts, no storage, no single-writer
// lock), and a recipient's browser never downloads the editor. A chunk that fails once is retried.
const Reader = lazy(() => import('./Reader').catch(() => import('./Reader')).then((m) => ({ default: m.Reader })));
const Library = lazy(() => import('./Library').catch(() => import('./Library')).then((m) => ({ default: m.Library })));

/** "/l/" is the reader too (a pasted or hand-typed link); the fragment (the letter) is kept. */
function isReaderPath(): boolean {
  if (location.pathname === '/l/') history.replaceState(history.state, '', `/l${location.search}${location.hash}`);
  return location.pathname === '/l';
}

export function App() {
  // app start shows only the ground color (21A) while the chunk arrives
  return <Suspense fallback={<div className="boot" aria-busy="true" />}>{isReaderPath() ? <Reader /> : <Library />}</Suspense>;
}
