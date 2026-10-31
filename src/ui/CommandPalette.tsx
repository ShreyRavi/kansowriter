import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { Command } from 'cmdk';
import { useStore } from './store';
import { clamp, LIMITS, resolveTheme, TYPEFACES, type Settings, type ThemeChoice, type Typeface } from './settings';
import { isMac } from './platform';
import { SearchIcon } from './icons';
import { useDialog } from './useDialog';
import type { FocusMode } from '../editor/focus';
import type { PaletteActions } from './paletteActions';
import { SOURCE_URL, VERSION_LABEL } from '../version';

const THEME_LABELS: Record<ThemeChoice, string> = { system: 'System', paper: 'Light', night: 'Dark' };
type Expandable = 'theme' | 'typeface' | 'hide';
const mod = () => (isMac() ? '⌘' : 'Ctrl ');
type NumKey = 'textSize' | 'lineWidth' | 'goal';
const FAILED = 'Couldn’t do that. Try again';

/**
 * ⌘K palette: every setting lives here (no settings screen). Rows edit in place (19A):
 * toggles flip on Enter, choices cycle on Enter or expand on →, numbers become an inline field;
 * destructive commands confirm inside their row (8A); results show in place (9A).
 */
export function CommandPalette({
  onClose,
  actions,
  title,
  wordsToday,
}: {
  onClose(): void;
  actions: PaletteActions;
  title: string;
  wordsToday: number;
}) {
  const { settings, update } = useStore();
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<NumKey | 'rename' | null>(null);
  const [draftValue, setDraftValue] = useState('');
  const [expanded, setExpanded] = useState<Expandable | null>(null);
  const [confirm, setConfirm] = useState<'delete' | 'clear' | null>(null);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useDialog(ref, onClose, inputRef);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  /** show a result in the row (9A); `hold` keeps it until the next flash (e.g. "Saving…") */
  const flash = (key: string, text: string | null, hold = false) => {
    clearTimeout(timers.current.get(key));
    if (!text) return setLabels((l) => ({ ...l, [key]: '' }));
    setLabels((l) => ({ ...l, [key]: text }));
    if (!hold)
      timers.current.set(
        key,
        setTimeout(() => setLabels((l) => ({ ...l, [key]: '' })), 2500),
      );
  };
  const run = (key: string, pending: string, f: () => Promise<string | null>) => {
    flash(key, pending, true);
    // a rejection must never leave "Saving…" / "Clearing…" in the row
    void f().then(
      (t) => flash(key, t),
      () => flash(key, FAILED),
    );
  };
  const backToSearch = () => inputRef.current?.focus();
  const closeChoices = () => {
    setExpanded(null);
    backToSearch();
  };
  const closeConfirm = () => {
    setConfirm(null);
    backToSearch();
  };

  const startEdit = (key: NumKey | 'rename') => {
    setEditing(key);
    setDraftValue(key === 'rename' ? title : String(settings[key]));
  };
  const commitEdit = () => {
    if (editing === 'rename') flash('rename', actions.rename(draftValue));
    else if (editing && draftValue.trim()) {
      // an emptied field keeps the current value (Number('') is 0, which would clamp to the minimum)
      const n = Number(draftValue);
      if (Number.isFinite(n))
        update({ [editing]: clamp(Math.round(n / LIMITS[editing].step) * LIMITS[editing].step, LIMITS[editing]) } as Partial<Settings>);
    }
    setEditing(null);
    backToSearch();
  };
  const cancelEdit = () => {
    setEditing(null);
    backToSearch();
  };
  const step = (key: NumKey, dir: 1 | -1) => {
    const base = Number.isFinite(Number(draftValue)) ? Number(draftValue) : settings[key];
    const n = clamp(base + dir * LIMITS[key].step, LIMITS[key]);
    setDraftValue(String(n));
    update({ [key]: n } as Partial<Settings>);
  };
  // steppers must not take focus from the field (its blur commits and closes the editor)
  const keepFocus = (e: { preventDefault(): void }) => e.preventDefault();

  // System follows the device's light/dark setting; Light and Dark override it (⌘⇧N flips between them)
  const themeCycle: ThemeChoice[] = ['system', 'paper', 'night'];
  const themeLabel =
    settings.theme === 'system' ? `System (${resolveTheme('system') === 'night' ? 'dark' : 'light'})` : THEME_LABELS[settings.theme];
  const hideLabel = settings.hideChrome === 'never' ? 'Never' : `After ${settings.hideChrome} s`;
  const hideCycle: Settings['hideChrome'][] = ['never', 3, 10];
  const faces = Object.keys(TYPEFACES) as Typeface[];
  const onOff = (b: boolean) => (b ? 'On' : 'Off');
  const setFocus = (m: FocusMode) => update({ focus: settings.focus === m ? 'off' : m });

  const numField = (key: NumKey, unit = '') =>
    editing === key ? (
      <span className="val" data-local-escape onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="icon-btn stepper"
          aria-label="Decrease"
          data-tip="Decrease"
          onMouseDown={keepFocus}
          onClick={() => step(key, -1)}
        >
          −
        </button>
        <input
          autoFocus
          inputMode="numeric"
          aria-label={key}
          value={draftValue}
          onChange={(e) => setDraftValue(e.target.value)}
          onKeyDown={(e: ReactKeyboardEvent<HTMLInputElement>) => {
            e.stopPropagation();
            if (e.key === 'Enter') commitEdit();
            else if (e.key === 'Escape') cancelEdit();
            else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
              e.preventDefault();
              step(key, e.key === 'ArrowRight' ? 1 : -1); // live preview behind the palette
            }
          }}
          onBlur={commitEdit}
        />
        <button
          type="button"
          className="icon-btn stepper"
          aria-label="Increase"
          data-tip="Increase"
          onMouseDown={keepFocus}
          onClick={() => step(key, 1)}
        >
          +
        </button>
      </span>
    ) : (
      <Val value={`${settings[key]}${unit}`} />
    );

  return (
    <div className="palette-wrap" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <Command
          label="Commands and settings"
          loop
          shouldFilter={!editing && !confirm && !expanded}
          onKeyDown={(e: ReactKeyboardEvent) => {
            // → on a choice row expands its options (19A); only when the search caret is at the end.
            // only the three choice rows carry data-expand
            if (e.key !== 'ArrowRight' || editing || expanded || confirm) return;
            const input = inputRef.current;
            if (input && document.activeElement === input && input.selectionStart !== input.value.length) return;
            const row = ref.current?.querySelector('[cmdk-item][data-selected="true"]')?.getAttribute('data-expand');
            if (row) {
              e.preventDefault();
              setExpanded(row as Expandable);
            }
          }}
        >
          <div className="bar">
            <SearchIcon />
            <Command.Input ref={inputRef} value={query} onValueChange={setQuery} placeholder="Search commands and settings" />
            {/* a real button: on phones the sheet fills the screen and has no Esc key (ISSUE-001) */}
            <button type="button" className="close-btn" data-tip="Close Esc" data-tip-align="end" onClick={onClose}>
              <span className="close-label">Close</span>
              <span className="key" aria-hidden="true">
                esc
              </span>
            </button>
          </div>
          <Command.List>
            <Command.Empty>No commands match.</Command.Empty>

            <Command.Group heading="Appearance">
              <Command.Item
                value="Theme"
                data-expand="theme"
                keywords={['dark', 'light', 'night', 'paper', 'mode', 'system']}
                onSelect={() => update({ theme: themeCycle[(themeCycle.indexOf(settings.theme) + 1) % themeCycle.length]! })}
              >
                <span>Theme</span>
                <Val value={themeLabel} kbd={`${mod()}⇧N`} />
              </Command.Item>
              {expanded === 'theme' && (
                <Choices
                  options={themeCycle.map((t) => ({ id: t, label: THEME_LABELS[t] }))}
                  current={settings.theme}
                  onPick={(t) => {
                    update({ theme: t as ThemeChoice });
                    closeChoices();
                  }}
                  onClose={closeChoices}
                />
              )}
              <Command.Item value="Text size" onSelect={() => startEdit('textSize')}>
                <span>Text size</span>
                {numField('textSize', ' px')}
              </Command.Item>
              <Command.Item value="Line width" onSelect={() => startEdit('lineWidth')}>
                <span>Line width</span>
                {numField('lineWidth', ' px')}
              </Command.Item>
              <Command.Item
                value="Typeface"
                data-expand="typeface"
                onSelect={() => update({ typeface: faces[(faces.indexOf(settings.typeface) + 1) % faces.length]! })}
              >
                <span>Typeface</span>
                <Val value={TYPEFACES[settings.typeface].label} />
              </Command.Item>
              {expanded === 'typeface' && (
                <Choices
                  options={faces.map((f) => ({ id: f, label: TYPEFACES[f].label }))}
                  current={settings.typeface}
                  onPick={(f) => {
                    update({ typeface: f as Typeface });
                    closeChoices();
                  }}
                  onClose={closeChoices}
                />
              )}
            </Command.Group>

            <Command.Group heading="Focus">
              <Item
                label="Typewriter scrolling"
                value={onOff(settings.typewriter)}
                kbd={`${mod()}⇧T`}
                onSelect={() => update({ typewriter: !settings.typewriter })}
              />
              <Item
                label="Dim other paragraphs"
                value={onOff(settings.focus === 'paragraph')}
                kbd={`${mod()}⇧P`}
                onSelect={() => setFocus('paragraph')}
              />
              <Item
                label="Dim other sentences"
                value={onOff(settings.focus === 'sentence')}
                kbd={`${mod()}⇧S`}
                onSelect={() => setFocus('sentence')}
              />
              <Command.Item
                value="Hide interface when typing"
                data-expand="hide"
                onSelect={() => update({ hideChrome: hideCycle[(hideCycle.indexOf(settings.hideChrome) + 1) % hideCycle.length]! })}
              >
                <span>Hide interface when typing</span>
                <Val value={hideLabel} />
              </Command.Item>
              {expanded === 'hide' && (
                <Choices
                  options={hideCycle.map((h) => ({ id: String(h), label: h === 'never' ? 'Never' : `After ${h} s` }))}
                  current={String(settings.hideChrome)}
                  onPick={(id) => {
                    update({ hideChrome: id === 'never' ? 'never' : (Number(id) as 3 | 10) });
                    closeChoices();
                  }}
                  onClose={closeChoices}
                />
              )}
            </Command.Group>

            <Command.Group heading="Goal">
              <Command.Item value="Daily word goal" onSelect={() => startEdit('goal')}>
                <span>Daily word goal</span>
                {numField('goal')}
              </Command.Item>
              <Item label="Words today" value={`${wordsToday} of ${settings.goal}`} onSelect={() => {}} />
              <Item
                label="Show progress line"
                value={onOff(settings.showProgress)}
                onSelect={() => update({ showProgress: !settings.showProgress })}
              />
              <Item
                label="Reset today’s count"
                value={labels.reset ?? ''}
                onSelect={() =>
                  void actions.resetToday().then(
                    (t) => flash('reset', t),
                    () => flash('reset', FAILED),
                  )
                }
              />
            </Command.Group>

            <Command.Group heading="Document">
              <Item label="Send as letter" kbd={`${mod()}⇧L`} onSelect={actions.sendLetter} />
              <Item label="New draft" onSelect={actions.newDraft} />
              <Item label="Open drafts" onSelect={actions.openDrafts} />
              <Command.Item value="Rename draft" onSelect={() => startEdit('rename')}>
                <span>Rename draft</span>
                {editing === 'rename' ? (
                  <span className="val" data-local-escape onClick={(e) => e.stopPropagation()}>
                    <input
                      autoFocus
                      className="wide"
                      aria-label="Draft title"
                      value={draftValue}
                      onChange={(e) => setDraftValue(e.target.value)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter') commitEdit();
                        if (e.key === 'Escape') cancelEdit();
                      }}
                    />
                  </span>
                ) : (
                  <Val value={labels.rename || ''} />
                )}
              </Command.Item>
              <Item
                label="Export as Markdown"
                value={labels.md || '.md'}
                kbd={`${mod()}E`}
                onSelect={() => run('md', 'Saving…', actions.exportMarkdown)}
              />
              <Item
                label="Export as plain text"
                value={labels.txt || '.txt'}
                kbd={`${mod()}⇧E`}
                onSelect={() => run('txt', 'Saving…', actions.exportText)}
              />
              <Item
                label="Save as Kansowriter file (.kanso)"
                value={labels.kanso || ''}
                onSelect={() => run('kanso', 'Saving…', actions.exportKanso)}
              />
              {actions.saveToFile && (
                <Item
                  label="Save to file…"
                  value={labels.file || '.md'}
                  kbd={`⌥${mod()}S`}
                  onSelect={() => run('file', 'Saving…', actions.saveToFile!)}
                />
              )}
              <Item label="Export all drafts" value={labels.all || ''} onSelect={() => run('all', 'Saving…', actions.exportAll)} />
              <Command.Item
                value="Import backup"
                keywords={['restore', 'draft', 'open']}
                onSelect={() => run('imp', 'Reading…', actions.importBackup)}
              >
                <span>Import backup</span>
                <Val value={labels.imp || ''} />
              </Command.Item>
              {actions.makeDefault && (
                <Item
                  label="Make Kansowriter the default for .md"
                  value={labels.def || ''}
                  onSelect={() => run('def', 'Asking…', actions.makeDefault!)}
                />
              )}
              {confirm === 'clear' ? (
                <Confirm
                  text={`Clear history of “${title || 'Untitled'}”? The text stays.`}
                  action="Clear"
                  onCancel={closeConfirm}
                  onConfirm={() => {
                    closeConfirm();
                    run('clear', 'Clearing…', actions.clearHistory);
                  }}
                />
              ) : (
                <Item label="Clear history (keep text)" value={labels.clear || ''} onSelect={() => setConfirm('clear')} />
              )}
              {confirm === 'delete' ? (
                <Confirm
                  text={`Delete “${title || 'Untitled'}”? This can’t be undone.`}
                  action="Delete"
                  extra={
                    <button type="button" className="text-btn" onClick={() => run('all', 'Saving…', actions.exportAll)}>
                      {labels.all || 'Export first'}
                    </button>
                  }
                  onCancel={closeConfirm}
                  onConfirm={() => {
                    closeConfirm();
                    run('delete', 'Deleting…', actions.deleteDraft);
                  }}
                />
              ) : (
                <Item label="Delete draft" value={labels.delete || ''} onSelect={() => setConfirm('delete')} />
              )}
            </Command.Group>

            <Command.Group heading="About">
              {/* the version, and the source on GitHub (the desktop app opens it in the browser) */}
              <Command.Item
                value="About Kansowriter"
                keywords={['version', 'source', 'github', 'commit']}
                onSelect={() => void window.open(SOURCE_URL, '_blank', 'noopener')}
              >
                <span>About Kansowriter</span>
                <Val value={`${VERSION_LABEL} · Source`} />
              </Command.Item>
            </Command.Group>
          </Command.List>
        </Command>
      </div>
    </div>
  );
}

function Val({ value, kbd }: { value: string; kbd?: string }) {
  return (
    <span className="val">
      {value && <span>{value}</span>}
      {kbd && <span className="key">{kbd}</span>}
    </span>
  );
}

function Item({ label, value = '', kbd, onSelect }: { label: string; value?: string; kbd?: string; onSelect(): void }) {
  return (
    <Command.Item value={label} onSelect={onSelect}>
      <span>{label}</span>
      <Val value={value} kbd={kbd} />
    </Command.Item>
  );
}

function Choices({
  options,
  current,
  onPick,
  onClose,
}: {
  options: { id: string; label: string }[];
  current: string;
  onPick(id: string): void;
  onClose(): void;
}) {
  const at = Math.max(
    0,
    options.findIndex((o) => o.id === current),
  );
  return (
    <div
      className="choices"
      role="group"
      data-local-escape
      onKeyDown={(e) => {
        const buttons = [...e.currentTarget.querySelectorAll('button')];
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === 'ArrowLeft' || e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          e.stopPropagation(); // cmdk would otherwise move its own selection
          buttons[(i + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
        } else if (e.key === 'Enter') e.stopPropagation();
      }}
    >
      {options.map((o, i) => (
        <button key={o.id} type="button" autoFocus={i === at} aria-pressed={o.id === current} onClick={() => onPick(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Confirm({
  text,
  action,
  extra,
  onCancel,
  onConfirm,
}: {
  text: string;
  action: string;
  extra?: ReactNode;
  onCancel(): void;
  onConfirm(): void;
}) {
  return (
    <div
      className="confirm"
      role="alertdialog"
      aria-label={text}
      data-local-escape
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
        if (!e.metaKey && !e.ctrlKey) e.stopPropagation(); // keep Enter/arrows on the focused button, not cmdk (⌘K still works)
      }}
    >
      <span>{text}</span>
      {extra}
      <span className="actions">
        <button type="button" className="text-btn" autoFocus onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="text-btn ink" onClick={onConfirm}>
          {action}
        </button>
      </span>
    </div>
  );
}
