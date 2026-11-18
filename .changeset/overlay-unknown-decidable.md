---
'@korajs/store': patch
---

Instant-update predictions whose outcome is unknown always get decided now. Two cases used to leave one shown, and possibly masking remote changes, until the app reloaded:

- A write the time limit had already marked unknown later learned which operation would prove it landed, and that operation was ignored. The next successful read now finds the operation and decides the write.
- A single write that produced no operation, and whose commit answer was lost, stayed unknown forever. It's now taken back, as a transaction already was, because it changed nothing.
