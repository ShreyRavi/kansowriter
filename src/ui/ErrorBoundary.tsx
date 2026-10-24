import { Component, type ReactNode } from 'react';

/**
 * Last resort for a render error anywhere (including a lazy chunk that failed to load after a
 * deploy): a calm screen in the boot style instead of a blank page. Drafts live in IndexedDB,
 * so nothing typed and saved is lost; Reload starts the app again.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="boot ui">
        <h1 className="sr-only">Kansowriter</h1>
        <p role="alert">Something went wrong. Your drafts are saved on this device.</p>
        <button type="button" className="text-btn" onClick={() => location.reload()}>
          Reload
        </button>
      </main>
    );
  }
}
