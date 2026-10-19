---
"@korajs/core": patch
"@korajs/merge": patch
"@korajs/server": patch
---

The server's startup re-materialization (first start after upgrading from beta.12, a fold plan change, a replace-mode restore) is linear in the operation log again. Rebuilding each operation's scope snapshot materialized every field of the record after every operation, so a `t.richtext()` body was re-merged from all its stored edits once per operation (quadratic: a 1,100-edit document needed about 600,000 Yjs merges, and a 25-document production database took over 30 minutes). Snapshots now materialize only the scalar fields they keep; the values are byte-identical. A 600-edit document migrates with 599 merges instead of about 223,000 (1.5 s instead of 187 s).

The migration commits in bounded transactions of whole records (at most 2,000 operations each), so the delivery-counter lock that appends take is held for one batch at a time, and a killed process resumes where it stopped; the scope snapshot rebuild is resumable too (`scope_snapshot_fields_pending`). A migration longer than 5 seconds logs its progress every 5 seconds.

Rich-text writes no longer re-merge the field's whole history: each server keeps the merge of the updates it materialized last per field (bounded, 64 MiB) and merges only what a write adds (one Yjs merge per write instead of one per stored edit: 600 merges, about 1 s, per write to a 600-edit document in the regression test). Merges over incomplete Yjs content are always done from scratch, so the bytes never depend on the cache.

New: `materialize(state, { fields })` materializes only the given fields, `FoldOptions.richtextKeyed` (a richtext merger told which record field it merges), and `mergeRichtextUpdate` in `@korajs/merge` (`mergeRichtext` without a base that also reports whether the merged Yjs document is complete).
