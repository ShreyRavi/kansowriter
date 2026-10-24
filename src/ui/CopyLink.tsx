import { useEffect, useRef, useState } from 'react';

const FEEDBACK_MS = 2000; // motion.feedback

/**
 * "Copy link" with feedback in place (9A): the label reads "Copied" for 2 s; if the clipboard
 * is blocked it reads "Couldn’t copy. Select the link below" and the link appears selected
 * under the button, ready for ⌘C / Ctrl C or the phone's Copy.
 */
export function CopyLink({ link, label = 'Copy link', className = 'text-btn', disabled }: { link: string; label?: string; className?: string; disabled?: boolean }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  /** the selected link stays after the label settles: it is how the link gets copied now */
  const [field, setField] = useState(false);
  const fieldRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  // a different link (another range or mode) is a fresh start
  useEffect(() => {
    setState('idle');
    setField(false);
  }, [link]);
  useEffect(() => {
    if (state !== 'failed') return;
    fieldRef.current?.focus();
    fieldRef.current?.select();
  }, [state]);

  const copy = async () => {
    if (timer.current) clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(link);
      setState('copied');
      setField(false);
    } catch {
      setState('failed');
      setField(true);
    }
    timer.current = setTimeout(() => setState('idle'), FEEDBACK_MS);
  };

  return (
    <span className="copy-link">
      <button type="button" className={className} disabled={disabled} onClick={() => void copy()}>
        <span aria-live="polite">{state === 'copied' ? 'Copied' : state === 'failed' ? 'Couldn’t copy. Select the link below' : label}</span>
      </button>
      {field && (
        <input ref={fieldRef} className="link-field" readOnly value={link} aria-label="Letter link" onFocus={(e) => e.currentTarget.select()} />
      )}
    </span>
  );
}
