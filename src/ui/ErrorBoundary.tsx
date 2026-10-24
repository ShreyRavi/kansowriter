import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import { isMac } from './platform';
import { unsavedText } from './unsaved';

interface State {
  failed: boolean;
  /** what the editor held that storage didn't, read before the editor unmounted */
  unsaved: string | null;
}

/**
 * Last resort for a render error anywhere: a calm screen in the boot style instead of a blank page.
 * It only says the drafts are saved when the editor had nothing unsaved; otherwise it keeps those
 * words copyable and guards the reload (the editor's own guard unmounted with it).
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false, unsaved: null };

  static getDerivedStateFromError(): State {
    // render phase, before the failed tree unmounts: the editor's refs still hold its text
    return { failed: true, unsaved: unsavedText() };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <Fallback unsaved={this.state.unsaved} />;
  }
}

function Fallback({ unsaved }: { unsaved: string | null }) {
  const [copyLabel, setCopyLabel] = useState<string | null>(null);
  const [showText, setShowText] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (unsaved === null) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ''; // older Chromium / Safari only prompt with this set
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [unsaved]);

  useEffect(() => {
    if (!showText) return;
    textRef.current?.focus();
    textRef.current?.select();
  }, [showText]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(unsaved ?? '');
      setCopyLabel('Copied');
    } catch {
      // clipboard blocked: show the text selected so ⌘C / Ctrl C (or the phone's Copy) works
      setShowText(true);
      textRef.current?.select();
      setCopyLabel(`Selected. Press ${isMac() ? '⌘C' : 'Ctrl C'} to copy`);
    }
  };

  return (
    <main className="boot ui">
      <h1 className="sr-only">Kansowriter</h1>
      {unsaved === null ? (
        <p role="alert">Something went wrong. Your drafts are saved on this device.</p>
      ) : (
        <>
          <p role="alert">Something went wrong. Some of your newest words weren’t saved.</p>
          <button type="button" className="text-btn" onClick={() => void copy()}>
            {copyLabel ?? 'Copy unsaved text'}
          </button>
          {showText && <textarea ref={textRef} className="unsaved-text" aria-label="Unsaved text" readOnly value={unsaved} />}
        </>
      )}
      <button type="button" className="text-btn" onClick={() => location.reload()}>
        Reload
      </button>
    </main>
  );
}
