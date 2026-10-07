---
'@korajs/store': patch
'@korajs/react': patch
'@korajs/vue': patch
'@korajs/svelte': patch
---

Rich-text controller never drops local edits. Saves write the full live Y.Doc instead of a base
snapshot plus tracked deltas, so a stored change arriving during the save debounce no longer
discards the waiting typing. A refused save keeps the edits in the document; the next edit or the
new `retrySave()` saves them, and the first successful save clears `error`. Edits still waiting
when the editor is destroyed are saved. New `hasUnsavedChanges` and `getUnsavedState()` (for a
recovery copy) on the controller and on `useRichText` in React, Vue and Svelte. Saves run one at
a time.
