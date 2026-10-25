import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { decodeLetter, LETTER_FILE_EXTENSION, lettersSupported, type Letter } from '../core/letter';
import { CopyLink } from './CopyLink';
import { prefersReducedMotion, Replay } from './Replay';

type View = { name: 'decoding' } | { name: 'empty' } | { name: 'damaged' } | { name: 'unsupported' } | { name: 'letter'; letter: Letter };

/** Chromium's File Handling API (an installed app opening a .kansoletter, R1) */
interface LaunchParams {
  files?: { getFile(): Promise<File> }[];
}
declare global {
  interface Window {
    launchQueue?: { setConsumer(consumer: (params: LaunchParams) => void): void };
  }
}

const ACCEPT = `${LETTER_FILE_EXTENSION},application/x-kansoletter`;

/**
 * Letter reader at /l (1A, 7A). Letter only: it never opens drafts, storage or the
 * single-writer lock, so it works on a device that has never written anything.
 *
 *   /l#v1.…  ─decode─► replay        /l (no fragment) ─► "Open a letter file" (+ drop zone)
 *   damaged / too large ─► "didn’t arrive whole"     no DecompressionStream (R14) ─► newer browser
 */
export function Reader() {
  const [view, setView] = useState<View>({ name: 'decoding' });
  const [ended, setEnded] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const reduced = prefersReducedMotion();
  const seq = useRef(0);

  const open = useCallback(async (encoded: string) => {
    const mine = ++seq.current;
    setEnded(false);
    if (!lettersSupported()) return setView({ name: 'unsupported' });
    setView({ name: 'decoding' });
    try {
      const letter = await decodeLetter(encoded.trim());
      if (mine === seq.current) setView({ name: 'letter', letter });
    } catch {
      if (mine !== seq.current) return;
      // browser support was checked above; a decoder 'unsupported' is an unknown letter version,
      // which this reader can't show either (no error codes on screen, 7A)
      setView({ name: 'damaged' });
    }
  }, []);

  const openFile = useCallback(
    async (file: File | null | undefined) => {
      if (!file) return;
      try {
        await open(await file.text());
      } catch {
        setView({ name: 'damaged' });
      }
    },
    [open],
  );

  useEffect(() => {
    document.title = 'A letter — Kansowriter';
    const fromHash = () => {
      const hash = location.hash.slice(1);
      if (hash) void open(hash);
      else setView((v) => (v.name === 'decoding' ? { name: 'empty' } : v));
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    // an installed app opened with a .kansoletter file (manifest file_handlers)
    window.launchQueue?.setConsumer((params) => {
      const handle = params.files?.[0];
      if (handle) void handle.getFile().then(openFile, () => setView({ name: 'damaged' }));
    });
    return () => window.removeEventListener('hashchange', fromHash);
  }, [open, openFile]);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void openFile(e.dataTransfer.files[0]);
  };
  const onDragOver = (e: DragEvent) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    setDragging(true);
  };

  const fileButton = (cls: string) => (
    <>
      <button type="button" className={cls} onClick={() => inputRef.current?.click()}>
        Open a letter file
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        aria-label="Letter file"
        onChange={(e) => {
          void openFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
    </>
  );

  if (view.name === 'letter')
    return (
      <main className="reader" aria-label="Letter">
        <h1 className="sr-only">A letter</h1>
        <Replay letter={view.letter} instant={reduced} controls label="Letter" className="reader-replay" onDone={() => setEnded(true)}>
          {(ended || reduced) && (
            <a className={`reader-end ui${reduced ? ' now' : ''}`} href="/">
              Written with Kansowriter
            </a>
          )}
        </Replay>
      </main>
    );

  return (
    <main className="reader reader-state">
      <h1 className="sr-only">A letter</h1>
      {view.name === 'empty' && (
        <div
          className={`drop-zone${dragging ? ' over' : ''}`}
          onDragOver={onDragOver}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          {fileButton('open-file')}
          <p className="ui drop-hint">or drop it here</p>
        </div>
      )}
      {view.name === 'damaged' && (
        <div className="reader-message" onDragOver={onDragOver} onDrop={onDrop}>
          <p role="alert">This letter didn’t arrive whole. Ask the sender to send the link again, or as a file.</p>
          {fileButton('text-btn')}
        </div>
      )}
      {view.name === 'unsupported' && (
        <div className="reader-message">
          <p role="alert">This letter needs a newer browser. Open it in Safari, Chrome or Firefox.</p>
          <CopyLink link={location.href} />
        </div>
      )}
    </main>
  );
}
