# TODOS

## Storage

### Import blocks other tabs' saving while it runs

**What:** Replay incoming and local drafts before opening `importAll`'s read-write transaction, and flush the open writer before importing.

**Why:** The import holds one read-write transaction over drafts/ops/snapshots/days while it replays every local draft (`localTexts`, `alreadyHere`). Every tab's `append` waits silently behind it, so no saving-error notice appears, a handover can hit the 2 s steal, and a tab closed meanwhile loses its open word.

**Context:** `src/storage/idb.ts` importAll (replay happens inside the transaction for local texts). Found by the /ship adversarial pass on feat/v0 (2026-10-24). Pair with a memory budget for huge backups (up to 256 MB decompressed can exhaust a phone tab).

**Effort:** M
**Priority:** P1
**Depends on:** None

### Backup validator accepts out-of-range numbers and whole-file rejects a few draft-level problems

**What:** Require non-negative safe integers for day `B`/`peak`/`resetOffset` (with `resetOffset <= peak`), sane `updatedAt`, an id length cap; and treat `\r` or out-of-order sessions in one draft as that draft damaged instead of rejecting the file.

**Why:** A crafted or odd backup can show absurd "words today", pin a draft to the top with a future timestamp, or (for `\r`/sessions) still make a whole backup unrestorable.

**Context:** `src/core/backup.ts` isDraft/isDay/isBackup. Per-draft tolerance already exists for op coverage (importAll counts damaged drafts). Found by the final /ship adversarial pass (2026-10-24).

**Effort:** S
**Priority:** P2
**Depends on:** None

### Takeover steals mid-save on slow storage

**What:** Decide whether the fixed 2 s steal timeout (R23) should extend while the holder reports an in-flight handover flush.

**Why:** On slow phone storage (or behind an import), a requester can steal while the holder's final write is still committing; one tab then lands on "This tab stopped saving" (nothing is lost; Copy is offered).

**Context:** `src/storage/lifecycle.ts` STEAL_AFTER_MS / waitForRelease. Design call, not a bug.

**Effort:** S
**Priority:** P3
**Depends on:** None

## Editor UI

### Clearer failure messages for old browsers and odd export errors

**What:** Feature-detect `CompressionStream('deflate-raw')` and say "This browser can't make backups (needs Safari 16.4+, Chrome 103+, Firefox 113+)"; map non-BackupError export/import failures to accurate messages.

**Why:** On older browsers export says "Your browser blocked the download" and import says "That file isn't a Kansowriter backup", which suggests the user's backup is corrupt.

**Context:** `src/core/backup.ts`, `src/ui/backupActions.ts`.

**Effort:** S
**Priority:** P2
**Depends on:** None

### Read-only follower cost on long drafts

**What:** Follow commits by applying new ops (`loadOps(draftId, shownHead)`) instead of a full `loadDraft` + diff per commit.

**Why:** A read-only tab replays up to 499 ops and diffs the whole document roughly every 500 ms while another tab types; costs CPU/battery on novel-length drafts.

**Context:** `src/ui/EditorShell.tsx` follower (`followText`). Already skips hidden tabs and coalesces.

**Effort:** M
**Priority:** P3
**Depends on:** None

### Small UI follow-ups from the final review

**What:** Partial-restore button: singular/plural label and accent colour (it is the only way forward); keep the partial-restore message visible if the draft list refreshes; per-row failure wording instead of "Couldn’t do that. Try again"; titled-draft creation failure leaves an orphan "Untitled" record with no feedback; sidebar body search cache goes stale while the sidebar stays open; "(from backup)" title suffix disappears on first edit.

**Why:** Polish and clarity; none loses text.

**Context:** `src/ui/Landing.tsx`, `src/ui/CommandPalette.tsx`, `src/ui/App.tsx` createDraft, `src/ui/LibrarySidebar.tsx`, `src/storage/idb.ts` copies.

**Effort:** M
**Priority:** P2
**Depends on:** None

## Tests

### Tests that can't fail the way their headers claim

**What:** Add a CommandPalette unit test where an action rejects outright (run()'s rejection branch); an e2e that aborts only the first palette chunk request and lets the retry succeed (or drop the retry claim — lazy() caches a failed import); onWritable stale-resume branch (match vs mismatch); deferred handover × stolen/disposed during clear.

**Why:** Coverage gaps named by the final review; behaviour is believed correct.

**Context:** `e2e/palette-failures.spec.ts`, `src/ui/EditorShell.tsx`, `src/storage/lifecycle.test.ts`.

**Effort:** M
**Priority:** P2
**Depends on:** None

### Decompression-bomb unit test timing

**What:** Measure `backup.test.ts` "caps decompressed size" duration on an idle machine and CI; if it approaches 5 s, make the bomb cheaper or record a measured timeout with before/after failure probability.

**Why:** It timed out at 5 s under load ~35 on the letters branch; raising the timeout blindly would be a gate relaxation.

**Context:** `src/core/backup.test.ts`.

**Effort:** S
**Priority:** P2
**Depends on:** None

## Completed
