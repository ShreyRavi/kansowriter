import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import type { ActiveFormats, Paragraph } from '../editor/format';
import { SHORTCUTS, shortcutLabel, type FormatId } from '../editor/keys';
import { isMac } from './platform';
import { BulletListIcon, ChecklistIcon, ChevronIcon, NumberedListIcon, QuoteIcon } from './icons';

/**
 * The formatting toolbar: paragraph style menu | lists + quote | B I U S. One component, two places:
 *  - `bar`: in the header (desktop), fading with the rest of the chrome
 *  - `dock`: a slim row above the on-screen keyboard (phones), see EditorShell
 *
 * Buttons never take focus from the editor on a click or tap (mousedown is prevented), so the
 * selection stays put; after a keyboard press the shell hands focus back to the editor. It is one
 * Tab stop (role=toolbar, roving tabindex; ←/→ move between buttons).
 */

const PARAGRAPHS: { id: Paragraph; label: string }[] = [
  { id: 'title', label: 'Title' },
  { id: 'heading', label: 'Heading' },
  { id: 'subheading', label: 'Subheading' },
  { id: 'normal', label: 'Normal' },
];

type ButtonId = Exclude<FormatId, Paragraph>;

const BUTTONS: { group: number; id: ButtonId; label: string; icon: ReactNode }[] = [
  { group: 1, id: 'bullet', label: 'Bulleted list', icon: <BulletListIcon /> },
  { group: 1, id: 'numbered', label: 'Numbered list', icon: <NumberedListIcon /> },
  { group: 1, id: 'check', label: 'Checklist', icon: <ChecklistIcon /> },
  { group: 1, id: 'quote', label: 'Quote', icon: <QuoteIcon /> },
  { group: 2, id: 'bold', label: 'Bold', icon: <b className="glyph">B</b> },
  { group: 2, id: 'italic', label: 'Italic', icon: <i className="glyph">I</i> },
  { group: 2, id: 'underline', label: 'Underline', icon: <u className="glyph">U</u> },
  { group: 2, id: 'strike', label: 'Strikethrough', icon: <s className="glyph">S</s> },
];

/** aria-keyshortcuts form: "Meta+Shift+H" */
function ariaKeys(id: FormatId, mac: boolean): string {
  const s = SHORTCUTS[id];
  const key = (mac && s.mac) || s.key;
  return key
    .split('-')
    .map((p) => (p === 'Mod' ? (mac ? 'Meta' : 'Control') : p.length === 1 ? p.toUpperCase() : p))
    .join('+');
}

interface Props {
  variant: 'bar' | 'dock';
  formats: ActiveFormats;
  disabled: boolean;
  /** apply a format to the editor (the shell hands focus back to the text); `set` for the style menu (never toggles off) */
  run(id: FormatId, mode?: 'set'): void;
  /** hand focus back to the text (a mouse-opened menu closed with Esc) */
  focusText(): void;
}

/** a press that isn't a pointer's: Enter / Space on a focused button (or a screen reader's click) */
const fromKeyboard = (e: MouseEvent) => e.detail === 0;
const keep = (e: MouseEvent) => e.preventDefault();

export function FormatToolbar({ variant, formats, disabled, run, focusText }: Props) {
  const mac = isMac();
  const rootRef = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState(0);
  const [menu, setMenu] = useState<{ keyboard: boolean } | null>(null);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const items = () => [...(rootRef.current?.querySelectorAll<HTMLButtonElement>('[data-tb]') ?? [])];
  const paragraph = PARAGRAPHS.find((p) => p.id === formats.paragraph)!;

  useEffect(() => {
    if (disabled) setMenu(null);
  }, [disabled]);

  // the dock's row scrolls sideways: its edges fade where there is more to scroll to
  const [fade, setFade] = useState('');
  const measure = () => {
    const el = rootRef.current;
    if (!el || variant !== 'dock') return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setFade(`${left ? ' fade-left' : ''}${right ? ' fade-right' : ''}`);
  };
  useLayoutEffect(() => {
    measure();
    if (variant !== 'dock') return;
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    let next: number;
    if (e.key === 'ArrowRight') next = (at + 1) % all.length;
    else if (e.key === 'ArrowLeft') next = (at - 1 + all.length) % all.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = all.length - 1;
    else return;
    e.preventDefault();
    setCurrent(next);
    all[next]!.focus();
  };

  const tip = (label: string, id: FormatId) => `${label} ${shortcutLabel(id, mac)}`;

  return (
    <>
      <div
        ref={rootRef}
        className={`format-bar ${variant}${fade}`}
        role="toolbar"
        aria-label="Formatting"
        aria-disabled={disabled || undefined}
        onMouseDown={keep}
        onKeyDown={onKeyDown}
        onScroll={measure}
      >
        <button
          ref={menuBtn}
          type="button"
          data-tb
          className="style-btn"
          tabIndex={current === 0 ? 0 : -1}
          disabled={disabled}
          aria-haspopup="menu"
          aria-expanded={!!menu}
          aria-label={`Paragraph style: ${paragraph.label}`}
          data-tip={menu ? undefined : 'Paragraph style'}
          onFocus={() => setCurrent(0)}
          onClick={(e) => setMenu((m) => (m ? null : { keyboard: fromKeyboard(e) }))}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setMenu({ keyboard: true });
            }
          }}
        >
          <span className="style-label" aria-hidden="true">
            {paragraph.label}
          </span>
          <ChevronIcon />
        </button>
        {BUTTONS.map((b, i) => (
          <span key={b.id} className="tb-item">
            {BUTTONS[i - 1]?.group !== b.group && <span className="tb-sep" aria-hidden="true" />}
            <button
              type="button"
              data-tb
              className="icon-btn tb-btn"
              tabIndex={current === i + 1 ? 0 : -1}
              disabled={disabled}
              aria-label={b.label}
              aria-pressed={formats[b.id]}
              aria-keyshortcuts={ariaKeys(b.id, mac)}
              data-tip={tip(b.label, b.id)}
              onFocus={() => setCurrent(i + 1)}
              onClick={() => run(b.id)}
            >
              {b.icon}
            </button>
          </span>
        ))}
      </div>
      {menu && (
        <StyleMenu
          anchor={menuBtn.current}
          up={variant === 'dock'}
          value={formats.paragraph}
          keyboard={menu.keyboard}
          mac={mac}
          onPick={(id) => {
            setMenu(null);
            run(id, 'set');
          }}
          onClose={(to) => {
            setMenu(null);
            if (to === 'button') menuBtn.current?.focus();
            else if (to === 'text') focusText();
          }}
        />
      )}
    </>
  );
}

interface MenuProps {
  anchor: HTMLElement | null;
  up: boolean;
  value: Paragraph;
  keyboard: boolean;
  mac: boolean;
  onPick(id: Paragraph): void;
  /** where focus goes: the menu's button (opened by keyboard), the text (opened by pointer), or stays */
  onClose(to: 'button' | 'text' | null): void;
}

/** The paragraph style menu (menuitemradio). Fixed to its button, so the dock's scrolling row can't clip it. */
function StyleMenu({ anchor, up, value, keyboard, mac, onPick, onClose }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 220)), top: up ? r.top - 4 : r.bottom + 4 });
  }, [anchor, up]);

  useEffect(() => {
    if (!keyboard || !pos) return;
    ref.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }, [keyboard, pos]);

  // closed by a press elsewhere, a resize, or Esc wherever focus is (a pointer-opened menu leaves it in the text)
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const away = (e: Event) => {
      if (!ref.current?.contains(e.target as Node) && !anchor?.contains(e.target as Node)) closeRef.current(null);
    };
    const resized = () => closeRef.current(null);
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      closeRef.current(keyboard ? 'button' : 'text');
    };
    document.addEventListener('mousedown', away, true);
    document.addEventListener('touchstart', away, { capture: true, passive: true });
    document.addEventListener('keydown', esc, true);
    window.addEventListener('resize', resized);
    return () => {
      document.removeEventListener('mousedown', away, true);
      document.removeEventListener('touchstart', away, true);
      document.removeEventListener('keydown', esc, true);
      window.removeEventListener('resize', resized);
    };
  }, [anchor, keyboard]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Tab') onClose(null);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const n = all.length;
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (at + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      all[next]?.focus();
    }
  };

  return (
    <div
      ref={ref}
      className={`style-menu ui${up ? ' up' : ''}`}
      role="menu"
      aria-label="Paragraph style"
      style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }}
      onMouseDown={keep}
      onKeyDown={onKeyDown}
    >
      {PARAGRAPHS.map((p) => (
        <button
          key={p.id}
          type="button"
          role="menuitemradio"
          aria-checked={p.id === value}
          aria-keyshortcuts={ariaKeys(p.id, mac)}
          tabIndex={-1}
          className={`style-item ${p.id}`}
          onClick={() => onPick(p.id)}
        >
          <span className="style-name">
            {p.label}
            {p.id === value && (
              <span className="style-check" aria-hidden="true">
                {' ✓'}
              </span>
            )}
          </span>
          <span className="key" aria-hidden="true">
            {shortcutLabel(p.id, mac)}
          </span>
        </button>
      ))}
    </div>
  );
}
