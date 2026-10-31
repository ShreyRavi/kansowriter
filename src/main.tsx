import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { startUpdates } from './ui/updates';
import './ui/styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

// the macOS app ships its files inside the .app: no service worker or update notice there
if (import.meta.env.MODE === 'desktop') void import('./platform/desktop').then((m) => m.startDesktop());
else startUpdates();
