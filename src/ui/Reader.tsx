import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import {
  decodeLetter,
  LETTER_CAP_BYTES,
  LETTER_FILE_EXTENSION,
  LETTER_MIME,
  letterFailure,
  lettersSupported,
  type Letter,
  type LetterFailure,
} from '../core/letter';
import { CopyLink } from './CopyLink';
import { Replay } from './Replay';

type View =
  | { name: 'decoding' }
  | { name: 'empty' }
  | { name: LetterFailure; from?: 'link' | 'file' }
  | { name: 'unsupported' }
  | { name: 'letter'; letter: Letter };

/** Chromium's File Handling API (an installed app opening a .kansoletter, R1) */
interface LaunchParams {
  files?: { getFile(): Promise<File> }[];
}
declare global {
  interface Window {
    launchQueue?: { setConsumer(consumer: (params: LaunchParams) => void): void };
  }
}

const ACCEPT = `${LETTER_FILE_EXTENSION},${LETTER_MIME}`;
/** a letter file is its encoded text plus, at most, a trailing newline or BOM: anything bigger is refused unread */
const FILE_SLACK_BYTES = 64;

const hasFiles = (e: DragEvent) => [...e.dataTransfer.types].includes('Files');

/**
 * Letter reader at /l (1A, 7A). Letter only: it never opens drafts, storage or the
 * single-writer lock, so it works on a device that has never written anything.
 *
 *   /l#v1.…  ─decode─► replay        /l (no fragment) ─► "Open a letter file" (+ drop zone)
 *   damaged / too large ─► "didn’t arrive whole"     no DecompressionStream (R14) ─► newer browser
 *   v2. and up ─► "a newer Kansowriter"              a file that isn't a letter ─► says so
 */
export function Reader() {
  const [view, setView] = useState<View>({ name: 'decoding' });
  const [ended, setEnded] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  /** each open (link, file, cleared hash) supersedes any decode still running */
  const seq = useRef(0);

  const open = useCallback(async (encoded: string, mine = ++seq.current, from: 'link' | 'file' = 'link') => {
    setEnded(false);
    if (!lettersSupported()) return setView({ name: 'unsupported' });
    setView({ name: 'decoding' });
    try {
      const letter = await decodeLetter(encoded.trim());
      if (mine === seq.current) setView({ name: 'letter', letter });
    } catch (e) {
      if (mine !== seq.current) return;
      // browser support was checked above: what's left is a newer letter, a file that was never a
      // letter, or a damaged one (no error codes on screen, 7A)
      setView({ name: letterFailure(e, from), from });
    }
  }, []);

  const openFile = useCallback(
    async (file: File | null | undefined) => {
      if (!file) return;
      const mine = ++seq.current;
      // over the cap it can't be a letter: never read it into memory
      if (file.size > LETTER_CAP_BYTES + FILE_SLACK_BYTES) {
        setEnded(false);
        return setView({ name: 'not-a-letter' });
      }
      try {
        const text = await file.text();
        if (mine === seq.current) await open(text, mine, 'file');
      } catch {
        if (mine === seq.current) setView({ name: 'damaged' });
      }
    },
    [open],
  );

  useEffect(() => {
    document.title = 'A letter — Kansowriter';
    const fromHash = () => {
      const hash = location.hash.slice(1);
      if (hash) return void open(hash);
      // a cleared fragment: drop whatever was showing or still decoding
      seq.current++;
      setEnded(false);
      setView({ name: 'empty' });
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    // an installed app opened with a .kansoletter file (manifest file_handlers)
    window.launchQueue?.setConsumer((params) => {
      const handle = params.files?.[0];
      if (!handle) return;
      // the same guard as every open: a link opened while the file is fetched wins over it
      const mine = ++seq.current;
      void handle.getFile().then(
        (file) => {
          if (mine === seq.current) void openFile(file);
        },
        () => {
          if (mine !== seq.current) return;
          setEnded(false);
          setView({ name: 'damaged' });
        },
      );
    });
    return () => window.removeEventListener('hashchange', fromHash);
  }, [open, openFile]);

  // a file dropped anywhere on the page opens here; the browser never navigates away to it
  const dropHandlers = {
    onDragOver: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setDragging(true);
    },
    onDragLeave: (e: DragEvent) => {
      // only when the pointer leaves the page, not when it crosses into a child
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
    },
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(false);
      void openFile(e.dataTransfer.files[0]);
    },
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
      <main className="reader" aria-label="Letter" {...dropHandlers}>
        <h1 className="sr-only">A letter</h1>
        <Replay letter={view.letter} controls label="Letter" className="reader-replay" onEnded={setEnded}>
          {ended && (
            <a className="reader-end ui" href="/">
              Written with Kansowriter
            </a>
          )}
        </Replay>
      </main>
    );

  return (
    <main className="reader reader-state" {...dropHandlers}>
      <h1 className="sr-only">A letter</h1>
      {view.name === 'empty' && (
        <div className={`drop-zone${dragging ? ' over' : ''}`}>
          {fileButton('open-file')}
          <p className="ui drop-hint">or drop it here</p>
        </div>
      )}
      {view.name === 'damaged' && (
        <div className="reader-message">
          <p role="alert">This letter didn’t arrive whole. Ask the sender to send the link again, or as a file.</p>
          {fileButton('text-btn')}
        </div>
      )}
      {view.name === 'newer' && (
        <div className="reader-message">
          <p role="alert">This letter was written with a newer Kansowriter. Open it in the latest version.</p>
          {/* a link can be carried to a newer copy; a file is opened again once this one updates */}
          {view.from === 'file' ? fileButton('text-btn') : <CopyLink link={location.href} />}
        </div>
      )}
      {view.name === 'not-a-letter' && (
        <div className="reader-message">
          <p role="alert">That file isn’t a Kansowriter letter.</p>
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
