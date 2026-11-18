---
'@korajs/store': patch
---

The IndexedDB durability barrier no longer reports a failure that didn't happen. It used to give up after three rounds when background snapshots kept taking the write slot, throwing "IndexedDB snapshot was not persisted" with no error, which postponed uploads. It now waits out snapshots already in flight however many there are, and fails only when its own strict snapshot fails or the adapter is disposed.
