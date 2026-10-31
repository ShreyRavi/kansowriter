import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { startUpdates } from './ui/updates';
import './ui/styles.css';

const render = () =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );

// the macOS app ships its files inside the .app: no service worker or update notice there. Its
// file side (linked .md files, the File menu) is ready before the first render, so a file opened
// at launch is never missed; the header makes room for the traffic lights from the first frame.
if (import.meta.env.MODE === 'desktop') {
  document.documentElement.setAttribute('data-desktop', '');
  // where a title bar would be: a drag strip on every page (the editor's header is one too)
  const strip = document.createElement('div');
  strip.className = 'window-drag';
  strip.setAttribute('data-tauri-drag-region', '');
  strip.setAttribute('aria-hidden', 'true');
  document.body.prepend(strip);
  void import('./platform/desktop')
    .then((m) => m.startDesktop())
    .catch(() => {})
    .finally(render);
} else {
  render();
  startUpdates();
}
