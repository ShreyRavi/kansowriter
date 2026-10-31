/** What the ⌘K palette can do to the open draft (kept apart so EditorShell doesn't pull in the lazy palette chunk). */
export interface PaletteActions {
  /** closes the palette and opens the send preview (2A, 3A) */
  sendLetter(): void;
  newDraft(): void;
  openDrafts(): void;
  /** a label when the draft can't be renamed in this tab; null when renamed */
  rename(title: string): string | null;
  exportMarkdown(): Promise<string>;
  exportText(): Promise<string>;
  exportAll(): Promise<string>;
  /** a .kansobackup or a .kanso (which then opens its draft) */
  importBackup(): Promise<string | null>;
  /** the draft with its whole history as a .kanso (download on the web, save panel on macOS); null when cancelled */
  exportKanso(): Promise<string | null>;
  /** macOS only: link the draft to a Markdown file (File > Save to File…); null when cancelled */
  saveToFile?(): Promise<string | null>;
  /** macOS only: make Kansowriter the default app for .md */
  makeDefault?(): Promise<string>;
  clearHistory(): Promise<string>;
  /** resolves to an error label when the draft could not be deleted */
  deleteDraft(): Promise<string | null>;
  /** resolves to the label to show in the row ('Reset', or why it couldn't) */
  resetToday(): Promise<string>;
}
