---
'@korajs/svelte': patch
---

`KoraQuery` no longer swallows errors, flashes an empty list, or rebuilds an equal query.

- **Errors:** a failed query reaches the new `onError` prop and the snippet's second argument (`{ data, error, ready, source, complete }`). Without `onError`, the failure is logged.
- **Switching queries:** the previous rows stay until the new query answers.
- **Equal queries:** a new builder with the same descriptor keeps its subscription instead of rebuilding it.

`KoraQuery` now runs on the same machinery as `createQueryStateStore`.
