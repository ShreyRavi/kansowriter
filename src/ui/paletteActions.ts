/** What the ⌘K palette can do to the open draft (kept apart so EditorShell doesn't pull in the lazy palette chunk). */
export interface PaletteActions {
  newDraft(): void;
  openDrafts(): void;
  /** resolves to a label when the draft can't be renamed in this tab */
  rename(title: string): string | null;
  exportMarkdown(): Promise<string>;
  exportText(): Promise<string>;
  exportAll(): Promise<string>;
  importBackup(): Promise<string | null>;
  clearHistory(): Promise<string>;
  /** resolves to an error label when the draft could not be deleted */
  deleteDraft(): Promise<string | null>;
  resetToday(): Promise<void>;
}
