---
"@korajs/store": patch
---

A remote operation or delivery batch whose storage transaction rejects after its body finished (for example the answer to COMMIT was lost to a storage-leader change) is no longer treated as not applied when it in fact landed. The store looks up the newest operation the attempt added to the log; when it is there (the transaction is atomic, so the whole batch landed) the store publishes the batch's effects (`operation:applied`, merge traces, subscription notifications, the sync engine's post-commit effects) and resolves as committed, instead of the sync engine re-applying the batch operation by operation as duplicates that emit nothing. When the operation is not in the log, or the lookup itself fails, the original error is thrown as before.
