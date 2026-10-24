import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { EditorView } from '@codemirror/view';
import { replaySteps, type Letter, type LetterMeta } from '../core/letter';
import { createReaderView, ReplayPlayer, type PlayerState } from '../editor/reader';

/** "A letter, written Oct 22" on the writer's calendar day (meta.tz), or null without meta. */
export function writtenLine(meta: LetterMeta | undefined, now = Date.now()): string | null {
  const at = meta?.writtenAt;
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  const tz = typeof meta?.tz === 'number' && Number.isFinite(meta.tz) && Math.abs(meta.tz) <= 1440 ? meta.tz : null;
  const d = new Date(tz === null ? at : at - tz * 60_000);
  if (Number.isNaN(d.getTime())) return null;
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', ...(tz === null ? {} : { timeZone: 'UTC' }) };
  if (d.getUTCFullYear() !== new Date(now).getUTCFullYear()) opts.year = 'numeric';
  return `A letter, written ${d.toLocaleDateString(undefined, opts)}`;
}

export const prefersReducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const clock = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const IDLE_MS = 3000; // motion.chromeFadeDelay

interface Props {
  letter: Letter;
  /** prefers-reduced-motion (or a static preview): final text at once, no caret, no controls */
  instant: boolean;
  /** the reader's quiet controls (1A); the send preview has none */
  controls: boolean;
  /** "Letter" in the reader, "Letter preview" in the send panel */
  label: string;
  className?: string;
  onDone?(): void;
  /** below the text: the reader's end-state link */
  children?: ReactNode;
}

/**
 * One letter replaying (1A): date line, the letter column, the 2px replay line, and (reader
 * only) a controls row that stays hidden until the reader moves, touches or presses a key.
 */
export function Replay({ letter, instant, controls, label, className = '', onDone, children }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<ReplayPlayer | null>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<PlayerState>({ t: 0, duration: 0, playing: !instant, done: false });
  const [shown, setShown] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const doneRef = useRef(false);

  useEffect(() => {
    const host = hostRef.current!;
    doneRef.current = false;
    setState({ t: 0, duration: 0, playing: !instant, done: false });
    let view: EditorView;
    let player: ReplayPlayer;
    try {
      view = createReaderView(host, letter.baseText, label);
      player = new ReplayPlayer(view, letter.baseText, replaySteps(letter), (s) => {
        setState(s);
        if (s.done && !doneRef.current) {
          doneRef.current = true;
          onDoneRef.current?.();
        }
      });
    } catch {
      return; // decodeLetter validated the letter; nothing sensible to show otherwise
    }
    playerRef.current = player;
    if (instant) player.skipToEnd();
    else player.play();
    // a hidden tab doesn't watch: hold the replay there and pick it up on return
    let heldByHide = false;
    const onVis = () => {
      if (document.visibilityState === 'hidden' && player.isPlaying()) {
        heldByHide = true;
        player.pause();
      } else if (heldByHide) {
        heldByHide = false;
        player.play();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      player.destroy();
      view.destroy();
      playerRef.current = null;
    };
  }, [letter, instant, label]);

  // ---------- quiet controls ----------
  const reveal = useCallback(() => {
    setShown(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      // never fade while focus is inside the controls (17A)
      if (!controlsRef.current?.contains(document.activeElement)) setShown(false);
    }, IDLE_MS);
  }, []);
  const toggle = useCallback(() => {
    const p = playerRef.current;
    if (!p) return;
    if (p.isPlaying()) p.pause();
    else {
      doneRef.current = false;
      p.play();
    }
  }, []);
  useEffect(() => {
    if (!controls || instant) return;
    let last: { x: number; y: number } | null = null;
    const onMove = (e: PointerEvent) => {
      if (last && (Math.abs(e.clientX - last.x) > 2 || Math.abs(e.clientY - last.y) > 2)) reveal();
      last = { x: e.clientX, y: e.clientY };
    };
    const onKey = (e: KeyboardEvent) => {
      reveal();
      const el = e.target as HTMLElement | null;
      // Space pauses and resumes (17A), unless it is pressing a focused control
      if (e.key === ' ' && !el?.closest('button, input, a')) {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerdown', reveal);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', reveal);
      window.removeEventListener('keydown', onKey);
    };
  }, [controls, instant, reveal, toggle]);
  useEffect(() => () => void (hideTimer.current && clearTimeout(hideTimer.current)), []);

  const date = writtenLine(letter.meta);
  const pct = state.duration ? (state.t / state.duration) * 100 : state.done ? 100 : 0;
  const ended = state.done || (instant && state.duration === 0);

  return (
    <div className={`replay${ended ? ' ended' : ''} ${className}`}>
      {date && <p className="replay-date ui">{date}</p>}
      <div className="replay-page">
        <div ref={hostRef} className="replay-column" />
        {children}
      </div>
      {controls && !instant && (
        <div ref={controlsRef} className={`replay-controls ui chrome${shown ? '' : ' hidden'}`} onFocus={reveal}>
          <button type="button" className="text-btn" onClick={toggle}>
            {state.playing ? 'Pause' : state.done ? 'Replay' : 'Play'}
          </button>
          <input
            type="range"
            className="scrubber"
            aria-label="Replay position"
            min={0}
            max={Math.max(1, state.duration)}
            step={100}
            value={Math.round(state.t)}
            aria-valuetext={`${clock(state.t)} of ${clock(state.duration)}`}
            onChange={(e) => {
              doneRef.current = false;
              playerRef.current?.seek(Number(e.target.value));
            }}
          />
          <button type="button" className="text-btn" disabled={state.done} onClick={() => playerRef.current?.skipToEnd()}>
            Skip to the end
          </button>
        </div>
      )}
      <div className="progress replay-progress" aria-hidden="true">
        <div style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
