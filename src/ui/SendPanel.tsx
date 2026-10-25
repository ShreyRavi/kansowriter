import { useEffect, useRef, useState } from 'react';
import {
  baseTexts,
  buildLetter,
  defaultStart,
  encodeLetter,
  LETTER_FILE_EXTENSION,
  LETTER_MIME,
  LetterError,
  letterMeta,
  LINK_THRESHOLD_BYTES,
  startPoints,
  type Letter,
} from '../core/letter';
import type { Op } from '../core/kop';
import type { DraftRecord } from '../core/draft';
import { useStore } from './store';
import { useDialog } from './useDialog';
import { CloseIcon } from './icons';
import { CopyLink } from './CopyLink';
import { Replay } from './Replay';
import { letterLink } from './letterLinks';
import { download, safeFileName } from './platform';

interface Source {
  record: DraftRecord;
  base: string;
  ops: Op[];
  /** the draft's text as storage has it (the last state that applied, when damaged) */
  text: string;
  /** part of the history didn't apply: ops stop at the last one that did */
  damaged: boolean;
  /** start points the slider snaps to, and the text at each (computed once per open) */
  points: number[];
  texts: Map<number, string>;
}

type Mode = 'replay' | 'final';
/** which inputs a letter was made from: a result for other inputs is never sent */
const keyOf = (mode: Mode, start: number) => (mode === 'final' ? 'final' : `replay:${start}`);

type Settled = { key: string } & ({ status: 'ok'; encoded: string } | { status: 'too-large' } | { status: 'error' });

const kb = (bytes: number) => `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
const FEEDBACK_MS = 2000; // motion.feedback
const SETTLE_MS = 120;

/** Where a start point sits in time, for the slider's value text. */
function startLabel(rec: DraftRecord, start: number): string {
  if (start === 0) return 'the beginning';
  const s = rec.sessions.find((x) => x.opIndex === start);
  return s
    ? new Date(s.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : 'the beginning';
}

function makeLetter(src: Source, mode: Mode, start: number): Letter {
  // dated by the replay's first op (or, for final text, when the writing ended)
  const meta = letterMeta(src.record.sessions, src.ops, mode === 'final' ? src.ops.length : start);
  const m = Object.keys(meta).length ? meta : undefined;
  // final text is the saved text itself: nothing is replayed to get it
  if (mode === 'final') return buildLetter(src.base, src.ops, src.ops.length, 'final', m, src.text);
  const at = src.texts.get(start);
  return at === undefined ? buildLetter(src.base, src.ops, start, 'replay', m) : buildLetter(at, src.ops.slice(start), 0, 'replay', m);
}

/**
 * Send preview (2A): a live reader preview that restarts on every range or mode change, the
 * mode toggle, a "start replay from" slider snapping to sessions, the size note, the privacy
 * line (R25) and one primary button: Copy link, or Download letter file over the link size.
 * The editor has already flushed its writer; this only reads storage (read-only tabs can send).
 * `unsaved`: the editor still holds words storage doesn't (a stale tab, or a save that failed).
 */
export function SendPanel({
  draftId,
  title,
  unsaved = false,
  onClose,
}: {
  draftId: string;
  title: string;
  unsaved?: boolean;
  onClose(): void;
}) {
  const { storage } = useStore();
  const ref = useRef<HTMLDivElement>(null);
  const [source, setSource] = useState<Source | 'loading' | 'error'>('loading');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [mode, setMode] = useState<Mode>('replay');
  const [start, setStart] = useState(0);
  /** the letter for the settled inputs, tagged with them */
  const [letter, setLetter] = useState<{ key: string; letter: Letter } | null>(null);
  /** the last encode that finished (possibly for earlier inputs: shown, never sent) */
  const [settled, setSettled] = useState<Settled | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [saved, setSaved] = useState<string | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useDialog(ref, onClose);
  useEffect(() => () => void (savedTimer.current && clearTimeout(savedTimer.current)), []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      // one read transaction: record, base, ops and text all from the same moment
      const src = await storage.loadLetterSource(draftId);
      if (!alive) return;
      if (!src) return setSource('error');
      const points = startPoints(src.record.sessions, src.ops.length);
      const texts = baseTexts(src.base, src.ops, points);
      setStart(defaultStart(src.record.sessions, src.ops.length));
      setSource({ ...src, damaged: !!src.damaged, points, texts });
    })().catch(() => alive && setSource('error'));
    return () => {
      alive = false;
    };
  }, [storage, draftId, loadAttempt]);

  const ready = typeof source === 'object';
  const empty = ready && !source.text.trim();
  const key = keyOf(mode, start);

  // the letter as it stands, settled for a moment so dragging the slider doesn't restart on every tick
  useEffect(() => {
    if (typeof source !== 'object' || empty) return;
    const t = setTimeout(() => {
      try {
        setLetter({ key, letter: makeLetter(source, mode, start) });
      } catch {
        setLetter(null);
        setSettled({ key, status: 'error' });
      }
    }, SETTLE_MS);
    return () => clearTimeout(t);
  }, [source, empty, mode, start, key, attempt]);

  useEffect(() => {
    if (!letter) return;
    let alive = true;
    const { key: k } = letter;
    encodeLetter(letter.letter).then(
      (encoded) => alive && setSettled({ key: k, status: 'ok', encoded }),
      (e) => alive && setSettled({ key: k, status: e instanceof LetterError && e.kind === 'too-large' ? 'too-large' : 'error' }),
    );
    return () => {
      alive = false;
    };
  }, [letter]);

  /** the encoded letter for exactly what is chosen now, or null while it is being made */
  const current = settled && settled.key === key && letter?.key === key ? settled : null;
  const sendable = current?.status === 'ok' ? current.encoded : null;
  // the last settled result keeps the label and size steady while a new one is made (no flicker)
  const shownOk = settled?.status === 'ok' ? settled.encoded : null;
  const asLink = settled ? shownOk !== null && shownOk.length <= LINK_THRESHOLD_BYTES : true;

  const fileName = `${safeFileName(title)}${LETTER_FILE_EXTENSION}`;
  const points = ready ? source.points : [0];
  const at = Math.max(0, points.indexOf(start));

  const sizeNote =
    shownOk !== null
      ? shownOk.length <= LINK_THRESHOLD_BYTES
        ? `Fits in a link · ${kb(shownOk.length)}`
        : `Too long for a link · ${kb(shownOk.length)} file`
      : settled?.status === 'too-large'
        ? settled.key === 'final'
          ? 'Too long to send, even as final text.'
          : 'Too long to send. Start the replay later, or choose Final text only.'
        : settled?.status === 'error'
          ? 'Couldn’t prepare this letter.'
          : ' ';

  const saveFile = () => {
    if (sendable === null) return;
    download(fileName, sendable, LETTER_MIME);
    setSaved(`Saved ${fileName}`);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaved(null), FEEDBACK_MS);
  };

  const retryEncode = () => {
    setSettled(null);
    setAttempt((n) => n + 1);
  };
  const retryLoad = () => {
    setSource('loading');
    setLetter(null);
    setSettled(null);
    setLoadAttempt((n) => n + 1);
  };

  return (
    <div className="send-wrap" role="dialog" aria-modal="true" aria-labelledby="send-title" ref={ref}>
      <div className="send-top ui">
        <h2 id="send-title">Send as letter</h2>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      <div className="send-preview">{letter && !empty && <Replay letter={letter.letter} controls={false} label="Letter preview" />}</div>
      <div className="send-panel ui">
        {source === 'loading' ? (
          <div className="send-loading" aria-busy="true" />
        ) : source === 'error' ? (
          <div className="send-row">
            <p className="send-note" role="alert">
              Couldn’t read this draft.
            </p>
            <button type="button" className="text-btn" onClick={retryLoad}>
              Try again
            </button>
          </div>
        ) : empty ? (
          <p className="send-note">Nothing to send yet. Write something first.</p>
        ) : (
          <>
            {unsaved && (
              <p className="send-note send-warn" role="status">
                Your newest words aren’t saved yet, so they aren’t in this letter.
              </p>
            )}
            {source.damaged && (
              <p className="send-note send-warn" role="status">
                Part of this draft’s history couldn’t be read, so the replay ends where it breaks. Final text only sends the text as saved.
              </p>
            )}
            <fieldset className="send-mode">
              <legend className="sr-only">What the letter shows</legend>
              <label>
                <input type="radio" name="send-mode" checked={mode === 'replay'} onChange={() => setMode('replay')} />
                Replay
              </label>
              <label>
                <input type="radio" name="send-mode" checked={mode === 'final'} onChange={() => setMode('final')} />
                Final text only
              </label>
            </fieldset>
            {mode === 'replay' && points.length > 1 && (
              <label className="send-range">
                <span>Start replay from</span>
                <input
                  type="range"
                  min={0}
                  max={points.length - 1}
                  step={1}
                  value={at}
                  list="send-ticks"
                  aria-valuetext={startLabel(source.record, start)}
                  onChange={(e) => setStart(points[Number(e.target.value)] ?? 0)}
                />
                <datalist id="send-ticks">
                  {points.map((_, i) => (
                    <option key={i} value={i} />
                  ))}
                </datalist>
                <span className="send-from">{startLabel(source.record, start)}</span>
              </label>
            )}
            <div className="send-row">
              <span className="send-size" aria-live="polite">
                {sizeNote}
              </span>
              {current?.status === 'error' && (
                <button type="button" className="text-btn" onClick={retryEncode}>
                  Try again
                </button>
              )}
              {asLink && sendable !== null ? (
                <CopyLink link={letterLink(sendable)} className="primary-btn" />
              ) : asLink ? (
                <button type="button" className="primary-btn" disabled>
                  Copy link
                </button>
              ) : (
                <button type="button" className="primary-btn" disabled={sendable === null} onClick={saveFile}>
                  {saved ?? 'Download letter file'}
                </button>
              )}
            </div>
            <p className="send-privacy">
              Anyone with this link can read the letter. It lives in the link, in your chat and in browser history.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
