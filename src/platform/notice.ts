/** How long a desktop message ("Saved to notes.md") stays: DESIGN.md `feedback` is 2 s; a sentence needs longer. */
export const DESKTOP_NOTICE_MS = 5000;
const ID = 'kanso-desktop-notice';

export interface NoticeAction {
  label: string;
  run(): void;
}

/**
 * The app's notice strip (the `.notice` style), outside React, for what the desktop app says on
 * its own: an opened file, a save from the File menu, the one-time Markdown question. One at a
 * time: a new one replaces the last. `ms: null` keeps it until an action is taken.
 */
export function showDesktopNotice(
  text: string,
  actions: NoticeAction[] = [],
  ms: number | null = DESKTOP_NOTICE_MS,
  doc: Document = document,
): HTMLElement {
  doc.getElementById(ID)?.remove();
  const el = doc.createElement('div');
  el.id = ID;
  el.className = 'notice ui';
  el.setAttribute('role', 'status');
  const span = doc.createElement('span');
  span.textContent = text;
  el.append(span);
  if (actions.length) {
    const group = doc.createElement('span');
    group.className = 'actions';
    for (const a of actions) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'text-btn';
      b.textContent = a.label;
      b.addEventListener('click', () => {
        el.remove();
        a.run();
      });
      group.append(b);
    }
    el.append(group);
  }
  doc.body.append(el);
  if (ms !== null) setTimeout(() => el.remove(), ms);
  return el;
}

/** Whether a notice strip (the editor's or this one) is on screen. */
export function noticeShowing(doc: Document = document): boolean {
  return doc.querySelector('.notice') !== null;
}
