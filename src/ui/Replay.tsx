import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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

const clock = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const IDLE_MS = 3000; // motion.chromeFadeDelay
/** React hears about the clock at most this often (the replay line itself moves every frame) */
const STATE_EVERY_MS = 100;

interface Props {
  letter: Letter;
  /** the reader's quiet controls (1A); the send preview has none */
  controls: boolean;
  /** "Letter" in the reader, "Letter preview" in the send panel */
  label: string;
  className?: string;
  /** true when the replay reaches its end; false again when it restarts or seeks back */
  onEnded?(ended: boolean): void;
  /** below the text: the reader's end-state link */
  children?: ReactNode;
}

/**
 * One letter replaying (1A): date line, the letter column, the 2px replay line, and (reader
 * only) a controls row that stays hidden until the reader moves, touches or presses a key.
 *
 * The send preview and the reader replay the same way, reduced motion or not (17A: reduced
 * motion means a caret that never blinks and chrome that doesn't animate, never a different
 * letter). A letter with nothing to replay (final text only) shows its end state at once.
 */
export function Replay({ letter, controls, label, className = '', onEnded, children }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<ReplayPlayer | null>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<PlayerState>({ t: 0, duration: 0, playing: true, done: false });
  const [shown, setShown] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;

  useEffect(() => {
    const host = hostRef.current!;
    let view: EditorView | null = null;
    let player: ReplayPlayer;
    let ended = false;
    let last: PlayerState | null = null;
    let lastAt = 0;
    let trailing: ReturnType<typeof setTimeout> | null = null;
    let pending: PlayerState | null = null;
    const flush = (s: PlayerState) => {
      if (trailing) clearTimeout(trailing);
      trailing = null;
      pending = null;
      last = s;
      lastAt = performance.now();
      setState(s);
    };
    const report = (s: PlayerState) => {
      // the replay line follows every frame without a React render
      const bar = progressRef.current;
      if (bar) bar.style.width = `${s.duration ? (s.t / s.duration) * 100 : s.done ? 100 : 0}%`;
      const now = performance.now();
      // paused, every report lands (the scrubber and its value text follow each seek); playing,
      // at most one per STATE_EVERY_MS, with a trailing one so the newest state is never dropped
      if (
        !s.playing ||
        !last ||
        s.done !== last.done ||
        s.playing !== last.playing ||
        s.duration !== last.duration ||
        now - lastAt >= STATE_EVERY_MS
      ) {
        flush(s);
      } else {
        pending = s;
        trailing ??= setTimeout(() => pending && flush(pending), STATE_EVERY_MS - (now - lastAt));
      }
      if (s.done !== ended) {
        ended = s.done;
        onEndedRef.current?.(ended);
      }
    };
    try {
      view = createReaderView(host, letter.baseText, label);
      player = new ReplayPlayer(view, letter.baseText, replaySteps(letter), report);
    } catch {
      // decodeLetter validated the letter; nothing sensible to show otherwise
      view?.destroy();
      return;
    }
    playerRef.current = player;
    report({ t: 0, duration: player.duration, playing: true, done: false });
    player.play();
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
      if (trailing) clearTimeout(trailing);
      player.destroy();
      view?.destroy();
      playerRef.current = null;
    };
  }, [letter, label]);

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
    else p.play();
  }, []);
  /** nothing to replay (final text only): no Play, no scrubber */
  const still = state.done && state.duration === 0;
  useEffect(() => {
    if (!controls || still) return;
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
  }, [controls, still, reveal, toggle]);
  useEffect(() => () => void (hideTimer.current && clearTimeout(hideTimer.current)), []);

  const date = useMemo(() => writtenLine(letter.meta), [letter.meta]);

  return (
    <div className={`replay${state.done ? ' ended' : ''} ${className}`}>
      {date && <p className="replay-date ui">{date}</p>}
      <div className="replay-page">
        <div ref={hostRef} className="replay-column" />
        {children}
      </div>
      {controls && !still && (
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
            onChange={(e) => playerRef.current?.seek(Number(e.target.value))}
          />
          <button type="button" className="text-btn" disabled={state.done} onClick={() => playerRef.current?.skipToEnd()}>
            Skip to the end
          </button>
        </div>
      )}
      <div className="progress replay-progress" aria-hidden="true">
        <div ref={progressRef} />
      </div>
    </div>
  );
}
