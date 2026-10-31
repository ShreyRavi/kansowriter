import { useEffect, useState } from 'react';
import { useStore } from './store';
import { importBackup } from './backupActions';
import { LandingDemo } from './LandingDemo';
import { SOURCE_URL, VERSION, VERSION_LABEL } from '../version';

const LINE = 'A quiet place to write.';
const TYPED_KEY = 'kansowriter-landing-typed';

/** Irregular, human-feeling per-character delays summing to ~1.4 s (12A). */
function delays(text: string): number[] {
  const base = 1400 / text.length;
  return [...text].map((ch, i) => base * (ch === ' ' ? 1.8 : 0.7 + ((i * 37) % 10) / 15));
}

function useTypedLine(): { shown: string; done: boolean } {
  const reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  let already: boolean;
  try {
    already = sessionStorage.getItem(TYPED_KEY) === '1';
  } catch {
    already = false;
  }
  const instant = reduce || already;
  const [n, setN] = useState(instant ? LINE.length : 0);
  useEffect(() => {
    if (instant) return;
    const ds = delays(LINE);
    let i = 0;
    let t: ReturnType<typeof setTimeout>;
    const step = () => {
      i++;
      setN(i);
      if (i < LINE.length) t = setTimeout(step, ds[i]);
      else
        try {
          sessionStorage.setItem(TYPED_KEY, '1');
        } catch {
          /* fine */
        }
    };
    t = setTimeout(step, 300);
    return () => clearTimeout(t);
  }, [instant]);
  return { shown: LINE.slice(0, n), done: n >= LINE.length };
}

export function Landing({ onStart, onRestored }: { onStart(): void; onRestored(): void }) {
  const { storage, drafts } = useStore();
  const { shown, done } = useTypedLine();
  const [feedback, setFeedback] = useState<string | null>(null);
  /** some drafts were restored and some left out: wait for a click so the feedback can be read */
  const [partial, setPartial] = useState(false);
  const [caretGone, setCaretGone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setCaretGone(true), 600);
    return () => clearTimeout(t);
  }, [done]);

  const restore = async () => {
    setFeedback('Reading…');
    const r = await importBackup(storage);
    if (!r) return setFeedback(null);
    setFeedback(r.label);
    if (!r.added) return;
    // opening the editor right away would replace this page before "left out …" could be read
    if (r.damaged) setPartial(true);
    else onRestored();
  };

  return (
    <main className="landing">
      <section className="hero">
        <p className="wordmark">Kansowriter</p>
        <h1 aria-label={LINE}>
          <span aria-hidden="true">{shown}</span>
          <span aria-hidden="true" className="caret" style={{ opacity: caretGone ? 0 : 1 }} />
        </h1>
        <button type="button" className="start" onClick={onStart}>
          Start writing
        </button>
        {drafts.length === 0 && (
          <div className="restore ui">
            {partial ? (
              <button type="button" className="text-btn" onClick={onRestored}>
                Open restored drafts
              </button>
            ) : (
              <button type="button" className="text-btn" onClick={restore}>
                Restore from a backup
              </button>
            )}
            {feedback && (
              <p className="feedback" role="status">
                {feedback}
              </p>
            )}
          </div>
        )}
      </section>
      <LandingDemo />
      <section className="points" aria-label="About Kansowriter">
        <p>The interface hides while you type.</p>
        <p>A thin line fills as you reach your daily word goal.</p>
        <p>Drafts stay on your device. No account.</p>
      </section>
      <footer>
        <span>writer.kansoboard.com</span>
        <span aria-hidden="true">·</span>
        {VERSION.commitUrl ? (
          <a href={VERSION.commitUrl} target="_blank" rel="noopener">
            {VERSION_LABEL}
          </a>
        ) : (
          <span>{VERSION_LABEL}</span>
        )}
        <span aria-hidden="true">·</span>
        <a href={SOURCE_URL} target="_blank" rel="noopener">
          Source
        </a>
      </footer>
    </main>
  );
}
