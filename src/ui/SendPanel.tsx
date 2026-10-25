import { useEffect, useMemo, useRef, useState } from 'react';
import {
  buildLetter,
  defaultStart,
  encodeLetter,
  LETTER_CAP_BYTES,
  LETTER_FILE_EXTENSION,
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
import { prefersReducedMotion, Replay } from './Replay';
import { download, safeFileName } from './platform';

interface Source {
  record: DraftRecord;
  base: string;
  ops: Op[];
  final: string;
}

type Encoded = { status: 'working' } | { status: 'ok'; encoded: string } | { status: 'too-large' } | { status: 'error' };

const kb = (bytes: number) => `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
const FEEDBACK_MS = 2000; // motion.feedback

/** Where a start point sits in time, for the slider's value text. */
function startLabel(rec: DraftRecord, start: number): string {
  if (start === 0) return 'the beginning';
  const s = rec.sessions.find((x) => x.opIndex === start);
  return s
    ? new Date(s.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : 'the beginning';
}

/**
 * Send preview (2A): a live reader preview that restarts on every range or mode change, the
 * mode toggle, a "start replay from" slider snapping to sessions, the size note, the privacy
 * line (R25) and one primary button: Copy link, or Download letter file over the link size.
 * The editor has already flushed its writer; this only reads storage (read-only tabs can send).
 */
export function SendPanel({ draftId, title, onClose }: { draftId: string; title: string; onClose(): void }) {
  const { storage } = useStore();
  const ref = useRef<HTMLDivElement>(null);
  const [source, setSource] = useState<Source | null | 'error'>(null);
  const [mode, setMode] = useState<'replay' | 'final'>('replay');
  const [start, setStart] = useState(0);
  const [encoded, setEncoded] = useState<Encoded>({ status: 'working' });
  const [saved, setSaved] = useState<string | null>(null);
  useDialog(ref, onClose);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [loaded, ops, snaps] = await Promise.all([
        storage.loadDraft(draftId),
        storage.loadOps(draftId),
        storage.loadSnapshots(draftId),
      ]);
      if (!alive) return;
      if (!loaded) return setSource('error');
      const base = snaps.find((s) => s.opIndex === 0)?.text ?? '';
      setStart(defaultStart(loaded.record.sessions, ops.length));
      setSource({ record: loaded.record, base, ops, final: loaded.text });
    })().catch(() => alive && setSource('error'));
    return () => {
      alive = false;
    };
  }, [storage, draftId]);

  const points = useMemo(() => (source && source !== 'error' ? startPoints(source.record.sessions, source.ops.length) : [0]), [source]);
  const empty = !!source && source !== 'error' && !source.final.trim();

  // the letter as it stands, settled for a moment so dragging the slider doesn't restart on every tick
  const [letter, setLetter] = useState<Letter | null>(null);
  useEffect(() => {
    if (!source || source === 'error' || empty) return;
    const t = setTimeout(() => {
      try {
        // dated by the replay's first op (or, for final text, when the writing ended)
        const meta = letterMeta(source.record.sessions, source.ops, mode === 'final' ? source.ops.length : start);
        setLetter(buildLetter(source.base, source.ops, start, mode, Object.keys(meta).length ? meta : undefined));
      } catch {
        setSource('error');
      }
    }, 120);
    return () => clearTimeout(t);
  }, [source, start, mode, empty]);

  useEffect(() => {
    if (!letter) return;
    let alive = true;
    setEncoded({ status: 'working' });
    encodeLetter(letter).then(
      (e) => alive && setEncoded(e.length > LETTER_CAP_BYTES ? { status: 'too-large' } : { status: 'ok', encoded: e }),
      (e) => alive && setEncoded(e instanceof LetterError && e.kind === 'too-large' ? { status: 'too-large' } : { status: 'error' }),
    );
    return () => {
      alive = false;
    };
  }, [letter]);

  const fileName = `${safeFileName(title)}${LETTER_FILE_EXTENSION}`;
  const asLink = encoded.status === 'ok' && encoded.encoded.length <= LINK_THRESHOLD_BYTES;
  const link = encoded.status === 'ok' ? `${location.origin}/l#${encoded.encoded}` : '';
  const at = Math.max(0, points.indexOf(start));

  const sizeNote =
    encoded.status === 'ok'
      ? asLink
        ? `Fits in a link · ${kb(encoded.encoded.length)}`
        : `Too long for a link · ${kb(encoded.encoded.length)} file`
      : encoded.status === 'too-large'
        ? mode === 'replay'
          ? 'Too long to send. Start the replay later, or choose Final text only.'
          : 'Too long to send, even as final text.'
        : encoded.status === 'error'
          ? 'Couldn’t prepare this letter. Try again'
          : ' ';

  const saveFile = () => {
    if (encoded.status !== 'ok') return;
    download(fileName, encoded.encoded, 'application/x-kansoletter');
    setSaved(`Saved ${fileName}`);
    setTimeout(() => setSaved(null), FEEDBACK_MS);
  };

  return (
    <div className="send-wrap" role="dialog" aria-modal="true" aria-labelledby="send-title" ref={ref}>
      <div className="send-top ui">
        <h2 id="send-title">Send as letter</h2>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      <div className="send-preview">
        {letter && !empty && <Replay letter={letter} instant={prefersReducedMotion()} controls={false} label="Letter preview" />}
      </div>
      <div className="send-panel ui">
        {source === 'error' ? (
          <p className="send-note" role="alert">
            Couldn’t read this draft’s history. Try again
          </p>
        ) : empty ? (
          <p className="send-note">Nothing to send yet. Write something first.</p>
        ) : (
          <>
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
            {mode === 'replay' && points.length > 1 && source && (
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
              {asLink ? (
                <CopyLink link={link} className="primary-btn" />
              ) : (
                <button type="button" className="primary-btn" disabled={encoded.status !== 'ok'} onClick={saveFile}>
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
